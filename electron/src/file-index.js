// The file indexer behind core/FileSearch (SPEC §8.6): a chunked,
// cancellable walk of the configured scopes with a disk cache. Excludes
// come from FileSearch.DEFAULT_EXCLUDE_DIRS; hidden files only when the
// config says so. Deviations from SPEC [D]: no inotify watcher (re-walk
// on a 10-minute staleness timer and at startup), no .gitignore parsing,
// a 100k-entry cap instead of a 500k SQLite/FTS index.
var fs = require("fs")
var path = require("path")
var FileSearch = require("../../plugin/core/FileSearch.js")

var MAX_ENTRIES = 100000
var CACHE_VERSION = 1
var STALE_AFTER_MS = 10 * 60 * 1000

function createFileIndex(opts) {
  opts = opts || {}
  var roots = (opts.roots && opts.roots.length ? opts.roots : [opts.home]).filter(Boolean)
  var includeHidden = !!opts.includeHidden
  var exclude = opts.exclude || FileSearch.DEFAULT_EXCLUDE_DIRS
  var cachePath = opts.cachePath || ""

  var state = {
    entries: [],
    ready: false,
    loading: false,
    lastIndexedAt: 0,
    fromCache: false
  }
  var listeners = { changed: [] }
  var generation = 0

  function emit() { (listeners.changed || []).forEach(function(cb) { cb() }) }
  function shouldSkip(name) {
    // The root itself never passes through here (it enters the queue
    // directly), so every scope — including a user-set scope that happens
    // to sit inside AppData — gets the same excludes for its children.
    if (exclude.indexOf(name) >= 0) return true
    if (!includeHidden && FileSearch.isHidden(name)) return true
    return false
  }

  function loadCache() {
    if (!cachePath) return false
    try {
      var doc = JSON.parse(fs.readFileSync(cachePath, "utf8"))
      if (doc && doc.v === CACHE_VERSION && Array.isArray(doc.entries)) {
        state.entries = doc.entries
        state.lastIndexedAt = Number(doc.at) || 0
        state.ready = true
        state.fromCache = true
        return true
      }
    } catch (e) { /* no cache yet */ }
    return false
  }

  function saveCache() {
    if (!cachePath) return
    try {
      fs.mkdirSync(path.dirname(cachePath), { recursive: true })
      var tmp = cachePath + ".tmp"
      fs.writeFileSync(tmp, JSON.stringify({ v: CACHE_VERSION, at: state.lastIndexedAt, entries: state.entries }))
      fs.renameSync(tmp, cachePath)
    } catch (e) { /* cache is best-effort */ }
  }

  // Iterative walk: no recursion depth limits, one stat per entry for the
  // recency sort, yields to the event loop every few hundred entries so the
  // launcher stays responsive while indexing. [D]
  function walk() {
    if (state.loading) return Promise.resolve()
    var token = ++generation
    state.loading = true
    var out = []
    var truncated = false
    var queue = roots.map(function(r) { return { dir: String(r), root: true } })

    function step() {
      if (token !== generation) { state.loading = false; return Promise.resolve() }
      var budget = 400          // entries processed before yielding
      while (queue.length > 0 && budget > 0) {
        var job = queue.shift()
        var dir = job.dir
        var list
        try { list = fs.readdirSync(dir, { withFileTypes: true }) } catch (e) { continue }
        for (var i = 0; i < list.length; i++) {
          var dirent = list[i]
          var name = dirent.name
          var full = path.join(dir, name)
          if (dirent.isSymbolicLink()) continue            // no cycles [D]
          if (shouldSkip(name)) continue
          if (dirent.isDirectory()) {
            queue.push({ dir: full, root: false })
          } else if (dirent.isFile()) {
            var m = 0
            try { m = fs.statSync(full).mtimeMs } catch (e) { continue }
            out.push({ p: full, n: name, d: false, m: m })
          } else continue
          if (out.length >= MAX_ENTRIES) { truncated = true; queue.length = 0; break }
          if (--budget <= 0) break
        }
        if (budget <= 0 && queue.length > 0) break
      }
      if (queue.length > 0) {
        return new Promise(function(resolve) { setImmediate(resolve) }).then(step)
      }
      return null
    }

    return Promise.resolve().then(step).then(function() {
      if (token !== generation) return
      // Folders get an entry too (SPEC searches folders); their mtime comes
      // from the parent-walk stat of the dir itself.
      var dirs = []
      var seen = {}
      var dirSet = {}
      for (var q = 0; q < roots.length; q++) dirSet[roots[q]] = true
      // Collect visited directory paths cheaply from file paths.
      for (var i = 0; i < out.length; i++) {
        var parent = FileSearch.parentOf(out[i].p)
        while (parent && !dirSet[parent] && !seen[parent]) {
          seen[parent] = true
          var nm = parent.slice(parent.lastIndexOf("/") >= 0 ? parent.lastIndexOf("/") + 1 : 0) || parent
          dirs.push({ p: parent, n: path.basename(parent), d: true, m: 0 })
          var up = FileSearch.parentOf(parent)
          if (up === parent) break
          parent = up
        }
      }
      state.entries = dirs.concat(out)
      state.lastIndexedAt = Date.now()
      state.ready = true
      state.fromCache = false
      state.loading = false
      saveCache()
      emit()
      if (truncated && opts.log) opts.log("warning", "file index hit the " + MAX_ENTRIES + "-entry cap")
    }, function(err) {
      state.loading = false
      if (opts.log) opts.log("error", "file index failed: " + err)
      emit()
    })
  }

  function refreshIfStale(force) {
    if (state.loading) return
    if (force || Date.now() - state.lastIndexedAt > STALE_AFTER_MS) walk()
  }

  return {
    get entries() { return state.entries },
    get ready() { return state.ready },
    get loading() { return state.loading },
    get lastIndexedAt() { return state.lastIndexedAt },
    roots: roots,
    start: function() {
      var fromCache = loadCache()
      if (!fromCache || Date.now() - state.lastIndexedAt > STALE_AFTER_MS) walk()
      else emit()
    },
    refresh: function() { walk() },
    refreshIfStale: refreshIfStale,
    on: function(event, cb) { if (listeners[event]) listeners[event].push(cb) },
    setIncludeHidden: function(v) { includeHidden = !!v }
  }
}

if (typeof module !== "undefined") {
  module.exports = { createFileIndex: createFileIndex, MAX_ENTRIES: MAX_ENTRIES, STALE_AFTER_MS: STALE_AFTER_MS }
}
