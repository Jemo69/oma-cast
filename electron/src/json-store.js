// Port of plugin/services/JsonStore.qml (Quickshell FileView store) to
// node fs. Same ingest/migrate/read-only semantics, 250 ms debounced
// writes, atomic replace, external-change reload, changed/message signals.
var fs = require("fs")
var path = require("path")
var Migrate = require("../../plugin/core/Migrate.js")

function createStore(opts) {
  var store = {
    path: opts.path,
    migrations: opts.migrations,
    now: opts.now || Date.now,
    doc: null,
    loaded: false,
    readOnly: false,
    lastError: "",
    ready: false,
    _lastWritten: "",
    _saveTimer: null,
    _watcher: null,
    _listeners: { changed: [], message: [] }
  }

  function on(event, cb) { store._listeners[event].push(cb); return function() { store._listeners[event] = store._listeners[event].filter(function(f) { return f !== cb }) } }
  function emit(event, a, b) { store._listeners[event].forEach(function(cb) { cb(a, b) }) }
  store.on = on

  store.update = function(mutator) {
    if (!store.loaded || store.readOnly) return false
    var next = JSON.parse(JSON.stringify(store.doc))
    var result = mutator(next)
    store.doc = result === undefined ? next : result
    schedule()
    emit("changed")
    return true
  }

  function schedule() {
    if (store._saveTimer) clearTimeout(store._saveTimer)
    store._saveTimer = setTimeout(function() { store._saveTimer = null; store.write() }, 250)
  }

  store.flush = function() {
    if (!store._saveTimer) return
    clearTimeout(store._saveTimer)
    store._saveTimer = null
    store.write()
  }

  store.write = function() {
    if (!store.loaded || store.readOnly) return
    var text = Migrate.serialize(store.doc)
    if (text === store._lastWritten) return
    store._lastWritten = text
    try {
      var tmp = store.path + ".tmp"
      fs.writeFileSync(tmp, text)
      fs.renameSync(tmp, store.path)
    } catch (e) {
      emit("message", "error", "cannot write " + store.path + ": " + (e && e.message || e), null)
    }
  }

  store.ingest = function(text) {
    if (store.loaded && !store.readOnly && text === store._lastWritten) return

    var parsed = Migrate.parse(text)
    if (parsed.error) {
      store.readOnly = true
      store.lastError = "unreadable " + store.path + ": " + parsed.error
      emit("message", "error", store.lastError + " (left untouched; fix or remove it)", null)
      return
    }

    var result
    try {
      result = Migrate.migrate(parsed.doc, store.migrations, store.now())
    } catch (e) {
      store.readOnly = true
      store.lastError = "migration failed for " + store.path + ": " + e
      emit("message", "error", store.lastError, null)
      return
    }
    if (result.error) {
      store.readOnly = true
      store.lastError = result.error
      emit("message", "error", store.path + ": " + result.error, null)
      return
    }

    store.readOnly = result.readOnly
    store.lastError = ""
    if (result.readOnly)
      emit("message", "warning", store.path + " has schemaVersion " + result.from + ", newer than this build; not writing it", null)
    if (result.applied.length > 0)
      emit("message", "info", "migrated " + store.path, { from: result.from, to: result.to, applied: result.applied })

    store._lastWritten = String(text || "")
    store.doc = result.doc
    store.loaded = true
    if (result.changed) store.write()
    emit("changed")
  }

  // Load when ready; watch the file like FileView watchChanges (reload → ingest).
  store.start = function() {
    if (store.ready) return
    store.ready = true
    try {
      var text = fs.readFileSync(store.path, "utf8")
      store.ingest(text)
    } catch (e) {
      if (e && e.code === "ENOENT") store.ingest("")
      else {
        store.readOnly = true
        store.lastError = "cannot read " + store.path + ": " + (e && e.message || e)
        emit("message", "error", store.lastError, null)
        return
      }
    }
    try {
      store._watcher = fs.watch(store.path, { persistent: false }, function() {
        // onFileChanged → reload → ingest fresh text.
        try { store.ingest(fs.readFileSync(store.path, "utf8")) } catch (e) { /* deleted; ignore */ }
      })
    } catch (e) { /* watch unsupported; debounced writes still work */ }
  }

  store.dispose = function() {
    store.flush()
    if (store._watcher) { try { store._watcher.close() } catch (e) {} store._watcher = null }
  }

  return store
}

if (typeof module !== "undefined") {
  module.exports = { createStore: createStore }
}
