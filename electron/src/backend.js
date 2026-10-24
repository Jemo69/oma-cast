// Port of plugin/Backend.qml to node: the in-process backend the window
// talks to through core/Rpc. Same method surface, same names, same
// semantics; platform calls (clipboard, launching, opening URLs, pasting,
// agent hand-off) arrive as injected `host` adapters so this file stays
// testable outside Electron. Omarchy-menu providers/guards do not exist on
// Windows; apps come from the Start Menu instead. [D]
var Rpc = require("../../plugin/core/Rpc.js")
var Paths = require("../../plugin/core/Paths.js")
var Log = require("../../plugin/core/Log.js")
var Schema = require("../../plugin/core/Schema.js")
var Ranker = require("../../plugin/core/Ranker.js")
var Frecency = require("../../plugin/core/Frecency.js")
var RootSearch = require("../../plugin/core/RootSearch.js")
var Calculator = require("../../plugin/core/Calculator.js")
var Agent = require("../../plugin/core/Agent.js")
var FileSearch = require("../../plugin/core/FileSearch.js")
var SettingsView = require("../../plugin/core/SettingsView.js")
var jsonStore = require("./json-store")
var calcData = require("./calculator-data")

var VERSION = "0.1.0"

function createBackend(opts) {
  opts = opts || {}
  var paths = opts.paths || Paths.resolveWindows(opts.env || function(k) { return process.env[k] })
  var host = opts.host || {}
  var apps = opts.apps
  var fileIndex = opts.fileIndex || null
  var processes = opts.processes || null
  var nowMs = opts.now || Date.now

  var registry = Rpc.createRegistry()
  var startedAt = nowMs()

  var config = Schema.withConfigDefaults(null)
  var directoriesReady = false

  var candidates = []
  var candidatesById = {}
  var candidatesRevision = 0
  var storeRevision = 0
  var agentChecking = false
  var listeners = { notification: [] }

  var settingsStore = jsonStore.createStore({ path: paths.db + "/" + Schema.documents.settings.file, migrations: Schema.documents.settings.migrations, now: nowMs })
  var frecencyStore = jsonStore.createStore({ path: paths.db + "/" + Schema.documents.frecency.file, migrations: Schema.documents.frecency.migrations, now: nowMs })
  var calculatorStore = jsonStore.createStore({ path: paths.db + "/" + Schema.documents.calculator.file, migrations: Schema.documents.calculator.migrations, now: nowMs })
  var calculatorData = calcData.createData({ cacheDir: paths.cache, ratesEnabled: config.currencyRates })

  function log(level, category, message, metadata) {
    if (!Log.shouldLog(level, config.logLevel)) return
    var line = Log.format(level, category, message, metadata)
    if (opts.log) opts.log(level, line)
    else console.log(line)
  }
  function notify(method, data) {
    (listeners.notification || []).forEach(function(cb) { cb(method, data) })
  }
  function emit(method, data) {
    Rpc.emit(registry, method, data, function(m, error) { log("error", "rpc", "subscriber of " + m + " threw: " + error) })
    notify(method, data)
  }

  // ------------------------------------------------------------- general
  var api = {
    version: VERSION,
    paths: paths,
    registry: registry,
    get loading() { return !!((apps && apps.loading) || agentChecking
      || (fileIndex && fileIndex.loading) || (processes && processes.loading)) },
    get ready() { return directoriesReady && settingsStore.loaded && frecencyStore.loaded && calculatorStore.loaded },
    get storeRevision() { return storeRevision },
    get candidatesRevision() { return candidatesRevision },
    // Bumped when exchange rates or zone offsets arrive (the open
    // calculator row re-evaluates) — QML's calculatorRevision.
    get calculatorRevision() { return (calculatorData.rates ? 1 : 0) + calculatorData.ratesFetchedAt + calculatorData.zonesAt },
    get config() { return config },
    call: function(method, data) { return Rpc.call(registry, method, data) },
    callSync: function(method, data) { return Rpc.callSync(registry, method, data) },
    subscribe: function(method, callback) { return Rpc.subscribe(registry, method, callback) },
    emit: emit,
    onNotification: function(cb) { listeners.notification.push(cb) },
    // The Quickshell.iconPath / appLibrary.iconSource slot: resolve a row's
    // iconName (a .lnk path on Windows) to a drawable URL, lazily.
    appsIcon: function(iconName) {
      return apps && apps.iconSource ? apps.iconSource(String(iconName || "")) : Promise.resolve("")
    }
  }

  function searchContext() {
    return {
      commands: settingsStore.loaded ? settingsStore.doc.commands : {},
      frecency: frecencyStore.loaded ? frecencyStore.doc.items : {},
      nowMs: nowMs(),
      sensitivity: settingsStore.loaded ? settingsStore.doc.general.rootSearchSensitivity : "medium"
    }
  }
  function decorated(id) {
    var c = candidatesById[id]
    return c ? RootSearch.decorate(c, searchContext(), deps) : null
  }

  // ---------------------------------------------------------- candidates
  function appEntries() {
    return (apps ? apps.entries : []).filter(function(e) { return e && e.id && !e.noDisplay })
  }
  function rebuildCandidates() {
    var next = []
    var list = appEntries()
    for (var i = 0; i < list.length; i++) if (list[i] && list[i].id) next.push(RootSearch.appCandidate(list[i]))
    // No omarchy-shell to summon on Windows: drop the summoning builtin.
    for (var b = 0; b < RootSearch.BUILTINS.length; b++) {
      var def = RootSearch.BUILTINS[b]
      if (def.run && def.run.summon) continue
      next.push(RootSearch.builtinCandidate(def))
    }
    var byId = {}
    for (var j = 0; j < next.length; j++) byId[next[j].id] = next[j]
    candidates = next
    candidatesById = byId
    candidatesRevision++
  }

  var rebuildTimer = null
  function scheduleRebuild() {
    if (rebuildTimer) return
    rebuildTimer = setTimeout(function() { rebuildTimer = null; rebuildCandidates() }, 30)
  }

  var deps = { Ranker: Ranker, Frecency: Frecency }

  // ---------------------------------------------------------- calculator
  function calculatorEnv() {
    var hour12
    if (config.clockFormat === "auto") {
      var hc = ""
      try { hc = new Intl.DateTimeFormat().resolvedOptions().hourCycle || "" } catch (e) {}
      hour12 = hc === "h12" || hc === "h11"
    } else hour12 = config.clockFormat === "12h"
    return {
      nowMs: nowMs(),
      localOffset: -new Date().getTimezoneOffset(),
      hour12: hour12,
      rates: config.currencyRates ? calculatorData.rates : null,
      zones: calculatorData.zones,
      remToPxRate: config.remToPxRate,
      workHoursPerDay: config.workHoursPerDay
    }
  }
  function calculate(query) {
    try {
      return Calculator.evaluate(query, calculatorEnv())
    } catch (e) {
      log("error", "calculator", "evaluating failed: " + e, { query: query })
      return null
    }
  }
  function saveCalculation(entry) {
    calculatorStore.update(function(doc) {
      doc.history = Calculator.pushHistory(doc.history, {
        id: String(nowMs()), query: entry.query, result: entry.result, copy: entry.copy, kind: entry.kind
      }, nowMs())
    })
    emit("calculator.historyStateChanged", null)
  }

  // An action on the inline Calculator row or a Calculator History entry.
  function calculatorAction(action, entry, historyId) {
    switch (action) {
      case "open":
      case "copy-answer":
        if (!historyId) saveCalculation(entry)
        if (host.copy) host.copy(entry.copy)
        return { close: true, hud: "Copied to Clipboard" }
      case "paste-answer":
        if (!historyId) saveCalculation(entry)
        // Copies, waits for the window to unmap, sends Ctrl+V — the
        // omarchy-clipboard-paste-text contract, executed in main. [D]
        if (host.pasteText) host.pasteText(entry.copy)
        return { close: true }
      case "copy-question-answer":
        if (!historyId) saveCalculation(entry)
        if (host.copy) host.copy(entry.query + " = " + entry.result)
        return { close: true, hud: "Copied to Clipboard" }
      case "open-history":
        return { push: { kind: "calculator-history", title: "Calculator History" } }
      case "delete-entry":
        calculatorStore.update(function(doc) { doc.history = doc.history.filter(function(h) { return h.id !== historyId }) })
        emit("calculator.historyStateChanged", null)
        return { toast: { style: "success", title: "Entry deleted" } }
      case "delete-all-entries":
        calculatorStore.update(function(doc) { doc.history = [] })
        emit("calculator.historyStateChanged", null)
        return { toast: { style: "success", title: "History cleared" } }
    }
    throw new Error("Unknown action " + action)
  }
  function historyEntry(id) {
    var key = String(id).slice("calculator-history:".length)
    var list = calculatorStore.loaded ? calculatorStore.doc.history : []
    for (var i = 0; i < list.length; i++) if (list[i].id === key) return list[i]
    return null
  }

  // ------------------------------------------------------------- agent
  // The authorized hand-off (SPEC §2.0) becomes a config template on
  // Windows: agentCommand containing {prompt}, e.g. `wt.exe -w 0 claude`.
  // Empty → the action explains how to enable it. [D]
  var agentTimer = null
  function agentArgv(query) {
    var prompt = String(query === undefined || query === null ? "" : query)
    if (!prompt.trim()) throw new Error("Type a question first")
    if (prompt.indexOf("\u0000") >= 0) throw new Error("Questions cannot contain a NUL character")
    if (prompt.length > 16384) throw new Error("Keep the question under 16,385 characters")
    var template = String(config.agentCommand || "").trim()
    if (!template) throw new Error("Set agentCommand in config.json, e.g. \"wt.exe claude -- \\\"{prompt}\\\"\"")
    var quoted = '"' + prompt.replace(/(["\\])/g, "\\$1") + '"'
    return template.indexOf("{prompt}") >= 0
      ? template.split("{prompt}").join(quoted)
      : template + " " + quoted
  }
  function agentStart(query) {
    var command
    try { command = agentArgv(query) } catch (e) { emit("agent.launchFailed", { message: String(e.message || e) }); return }
    if (agentChecking) { emit("agent.launchFailed", { message: "Agent launch is already being checked" }); return }
    agentChecking = true
    var first = command.trim().split(/\s+/)[0].replace(/^"|"$/g, "")
    var done = false
    function finish(ok, message) {
      if (done) return
      done = true
      agentChecking = false
      if (agentTimer) { clearTimeout(agentTimer); agentTimer = null }
      if (!ok) { emit("agent.launchFailed", { message: message }); return }
      emit("agent.launchReady", { argv: command })
    }
    agentTimer = setTimeout(function() { finish(false, "Agent launch check timed out. Try again.") }, 5000)
    if (host.checkCommand) {
      host.checkCommand(first, function(ok, message) {
        finish(ok, message || "Agent command not found. Check agentCommand in config.json.")
      })
    } else finish(true)
  }

  // ----------------------------------------------------------- execution
  function recordVisit(id, query) {
    if (!frecencyStore.loaded) return
    frecencyStore.update(function(doc) {
      doc.items[id] = Frecency.recordVisit(doc.items[id] || null, nowMs(), query || "")
      if (query) doc.searchHistory = Schema.pushSearchHistory(doc.searchHistory, query)
    })
  }
  function updateCommand(id, mutator) {
    settingsStore.update(function(doc) {
      var current = doc.commands[id] || {}
      var next = mutator(JSON.parse(JSON.stringify(current)))
      var empty = true
      for (var k in next) if (next[k] !== null && next[k] !== undefined && next[k] !== "") empty = false
      if (empty) delete doc.commands[id]
      else doc.commands[id] = next
    })
    emit("settings.commandSettingsChanged", { commandId: id })
  }

  function toRow(c) { return { candidate: c, record: null } }

  // Kill Process view rows: biggest working set first (the snapshot
  // arrives sorted), PID as the subtitle, memory as the type label. [D]
  function processCandidate(r) {
    return {
      id: "process:" + r.pid,
      type: "process",
      kind: "process",
      title: r.name,
      subtitle: "PID " + r.pid,
      typeLabel: r.ws > 0 ? (Math.round(r.ws / 1048576 * 10) / 10) + " MB" : "",
      glyph: "\uf2db",                 // nf-fa-microchip
      glyphFont: "",
      pid: r.pid,
      path: r.path,
      rootSearch: { when: "searching" }
    }
  }
  function processRow(pid) {
    return processes ? processes.rows.filter(function(r) { return r.pid === Number(pid) })[0] : null
  }
  function actionsForSetting() {
    return [{ id: "open", title: "Change", shortcut: "↵", section: "primary", icon: "\uf0ad" }]
  }
  function actionsForProcess(row) {
    var list = [{ id: "open", title: "Kill Process", shortcut: "↵", section: "primary", icon: "\uf111" }]
    if (row && row.path) list.push({ id: "reveal", title: "Reveal in Explorer", shortcut: "Ctrl ↵", section: "primary", icon: "\uf06e" })
    list.push({ id: "copy-pid", title: "Copy PID", shortcut: "Ctrl Shift C", section: "copy", icon: "\uf0c5" })
    return list
  }

  // ------------------------------------------------------------ settings
  // ↵ on a settings row cycles to the next value: "general" goes through
  // the same validated store path as the RPC, "config" rewrites
  // config.json (the hotkey is re-registered immediately). [D]
  function applyConfigValue(key, value) {
    if (!Schema.validConfigValue(key, value)) throw new Error("Invalid value for " + key)
    config[key] = value
    try {
      require("fs").writeFileSync(paths.configFile, JSON.stringify(config, null, 2) + "\n")
    } catch (e) { throw new Error("cannot write " + paths.configFile + ": " + (e && e.message || e)) }
    if (key === "hotkey" && host.configChanged) host.configChanged()
    if (key === "fileSearchIncludeHidden" && fileIndex && fileIndex.setIncludeHidden) fileIndex.setIncludeHidden(value)
  }
  function applySetting(id, action) {
    if (action !== "open") throw new Error("Unknown action " + action)
    var def = SettingsView.find(id)
    if (!def) throw new Error("Unknown setting " + id)
    var current = SettingsView.valueOf(def, settingsStore.loaded ? settingsStore.doc.general : {}, config)
    var next = SettingsView.cycle(def, current)
    if (def.scope === "general") {
      var patch = {}
      patch[def.key] = next
      var r = Rpc.callSync(registry, "settings.updateGeneralSettings", patch)
      if (!r.ok) throw r.error
    } else {
      applyConfigValue(def.key, next)
    }
    return { toast: { style: "success", title: def.label + ": " + SettingsView.format(def, next) } }
  }

  // ---------------------------------------------------- processes (kill)
  function processAction(id, action) {
    var pid = Number(String(id).slice("process:".length))
    var row = processRow(pid)
    if (action === "copy-pid") {
      if (host.copy) host.copy(String(pid))
      return { toast: { style: "success", title: "PID " + pid + " copied" } }
    }
    if (action === "reveal") {
      if (!row || !row.path) throw new Error("Path unavailable for PID " + pid)
      if (host.reveal) host.reveal(row.path)
      return { close: true }
    }
    if (action !== "open") throw new Error("Unknown action " + action)
    if (!row) throw new Error("No such process " + pid)
    // Synchronous taskkill: a couple hundred ms on an explicit user action,
    // and the sync RPC world gets its toast immediately. [D]
    var res = processes.kill(pid)
    processes.remove(pid)
    if (!res.ok) {
      return { toast: { style: "failure", title: "Could not kill " + row.name + (res.message ? ": " + res.message : "") } }
    }
    processes.refresh(true)
    return { toast: { style: "success", title: row.name + " (" + pid + ") killed" } }
  }

  // ---------------------------------------------------------------- files
  function fileAction(id, action) {
    var p = String(id).slice("file:".length)
    if (action === "copy-path") {
      if (host.copy) host.copy(p)
      return { close: true, hud: "Copied to Clipboard" }
    }
    if (action === "reveal") { if (host.reveal) host.reveal(p); return { close: true } }
    if (action === "open") { if (host.openPath) host.openPath(p); return { close: true } }
    throw new Error("Unknown action " + action)
  }

  function performAction(data) {
    var id = String(data && data.id || "")
    var action = String(data && data.action || "open")
    var query = String(data && data.query || "").trim()
    // View rows resolve without a stored candidate.
    if (id.indexOf("setting:") === 0) return applySetting(id, action)
    if (id.indexOf("process:") === 0) return processAction(id, action)
    if (id.indexOf("file:") === 0) return fileAction(id, action)
    var candidate = decorated(id)
    if (!candidate) throw new Error("Unknown command " + id)

    if (action === "open") {
      switch (candidate.kind) {
        case "app":
          recordVisit(id, query)
          if (apps) apps.launch(candidate.appId)
          return { close: true }
        case "builtin":
          if (candidate.run.power) {
            // Sleep closes the window first (host delays past the unmap);
            // shutdown/restart stay open with a cancellable toast so the
            // 15-second schedule can be aborted from Ctrl+T. No frecency
            // for power actions — they must not crowd Suggestions. [D]
            if (candidate.run.power === "sleep") {
              if (host.power) host.power("sleep", 0)
              return { close: true, hud: "Sleeping…" }
            }
            if (host.power) host.power(candidate.run.power, candidate.run.delay || 15)
            var powerLabel = candidate.run.power === "restart" ? "Restart" : "Shut Down"
            return { toast: { style: "success", title: powerLabel + " in " + (candidate.run.delay || 15) + " seconds",
              actions: [{ id: "cancel-power", title: "Cancel " + powerLabel, done: powerLabel + " cancelled",
                call: { method: "system.cancelPowerShutdown", data: null } } ] } }
          }
          if (candidate.run.url) {
            var values = (data && data.arguments) || {}
            var missing = RootSearch.missingArgument(candidate.arguments, values)
            if (missing >= 0) throw new Error("Type a " + candidate.arguments[missing].placeholder.toLowerCase() + " first")
            recordVisit(id, query)
            if (host.openExternal) host.openExternal(RootSearch.fillArguments(candidate.run.url, values))
            return { close: true }
          }
          recordVisit(id, query)
          if (candidate.run.push) {
            // The Kill Process view wants a fresh snapshot on entry.
            if (candidate.run.push.kind === "processes" && processes) processes.refresh()
            return { push: candidate.run.push }
          }
          return { close: true }
        case "fallback":
          if (host.openExternal) host.openExternal(RootSearch.fallbackUrl(candidate, query))
          return { close: true }
      }
      throw new Error("Cannot open " + id)
    }

    switch (action) {
      case "copy-command":
      case "copy-id":
        if (host.copy) host.copy(action === "copy-id" ? candidate.appId : candidate.action)
        return { close: true, hud: "Copied to Clipboard" }
      case "favorite-add":
      case "favorite-remove":
      case "favorite-up":
      case "favorite-down":
        var orders = RootSearch.reorderFavorites(settingsStore.doc.commands, id, action)
        settingsStore.update(function(doc) {
          for (var key in orders) {
            var entry = doc.commands[key] || {}
            if (orders[key] === null) delete entry.favoriteOrder
            else entry.favoriteOrder = orders[key]
            if (Object.keys(entry).length === 0) delete doc.commands[key]
            else doc.commands[key] = entry
          }
        })
        var titles = { "favorite-add": "Added to Favorites", "favorite-remove": "Removed from Favorites", "favorite-up": "Moved Up", "favorite-down": "Moved Down" }
        return { toast: { style: "success", title: titles[action] } }
      case "set-alias":
        return { push: { kind: "alias", commandId: id, title: "Alias for " + candidate.title, value: candidate.alias } }
      case "remove-alias":
        updateCommand(id, function(s) { delete s.alias; return s })
        return { toast: { style: "success", title: "Alias removed" } }
      case "reset-ranking":
        frecencyStore.update(function(doc) { delete doc.items[id] })
        return { toast: { style: "success", title: "Ranking reset" } }
      case "disable":
        updateCommand(id, function(s) { s.enabled = false; return s })
        // Undo on Ctrl+T: there is no settings window to re-enable it yet.
        return { toast: { style: "success", title: candidate.title + " disabled", actions: [
          { id: "undo", title: "Undo", done: candidate.title + " enabled",
            call: { method: "settings.updateCommandSettings", data: { commandId: id, enabled: true } } }
        ] } }
    }
    throw new Error("Unknown action " + action)
  }

  // ------------------------------------------------------------- registry
  function registerServices() {
    Rpc.register(registry, "system", {
      healthPing: function() { return null },
      healthDatabase: function() {
        var t0 = nowMs()
        JSON.stringify(settingsStore.doc)
        JSON.stringify(frecencyStore.doc)
        return {
          workMs: nowMs() - t0,
          settings: { loaded: settingsStore.loaded, readOnly: settingsStore.readOnly, error: settingsStore.lastError },
          frecency: { loaded: frecencyStore.loaded, readOnly: frecencyStore.readOnly, error: frecencyStore.lastError },
          loaded: settingsStore.loaded, readOnly: settingsStore.readOnly, error: settingsStore.lastError
        }
      },
      info: function() {
        return {
          version: api.version,
          desktop: "windows",
          ready: api.ready,
          uptimeMs: nowMs() - startedAt,
          candidates: candidates.length,
          appLibrary: !!apps,
          methods: Rpc.methods(registry)
        }
      },
      getPaths: function() { return paths },
      // The toast's Undo for scheduled shutdown/restart (shutdown /a).
      cancelPowerShutdown: function() { if (host.cancelPower) host.cancelPower(); return null }
    })

    Rpc.register(registry, "settings", {
      getGeneralSettings: function() {
        if (!settingsStore.loaded) throw new Error("settings not loaded")
        return settingsStore.doc.general
      },
      updateGeneralSettings: function(data) {
        if (!settingsStore.loaded) throw new Error("settings not loaded")
        if (settingsStore.readOnly) throw new Error("settings are read-only: " + (settingsStore.lastError || "written by a newer build"))
        var patch = data && typeof data === "object" ? data : {}
        var current = settingsStore.doc.general
        for (var key in patch) {
          if (current[key] === undefined) throw new Error("Unknown general setting " + key)
          if (typeof patch[key] !== typeof current[key]) throw new Error("Setting " + key + " must be a " + typeof current[key])
          var choices = Schema.generalChoices[key]
          if (choices && choices.indexOf(patch[key]) < 0) throw new Error("Setting " + key + " must be one of " + choices.join(", "))
        }
        settingsStore.update(function(doc) { for (var k in patch) doc.general[k] = patch[k] })
        emit("settings.generalSettingsChanged", settingsStore.doc.general)
        return settingsStore.doc.general
      },
      getAllCommandSettings: function() { return settingsStore.doc.commands },
      getCommandSettings: function(data) { return settingsStore.doc.commands[String(data && data.commandId || "")] || {} },
      updateCommandSettings: function(data) {
        var id = String(data && data.commandId || "")
        if (!candidatesById[id]) throw new Error("Unknown command " + id)
        if (data.alias !== undefined && data.alias !== null) {
          var alias = String(data.alias).trim().toLowerCase()
          if (/\s/.test(alias)) throw new Error("An alias cannot contain spaces")
          var commands = settingsStore.doc.commands
          for (var other in commands) {
            if (other !== id && commands[other].alias === alias && alias) throw new Error("Alias “" + alias + "” is already used by " + ((candidatesById[other] || {}).title || other))
          }
        }
        updateCommand(id, function(s) {
          if (data.alias !== undefined) { if (data.alias) s.alias = String(data.alias).trim().toLowerCase(); else delete s.alias }
          if (data.enabled !== undefined) { if (data.enabled === false) s.enabled = false; else delete s.enabled }
          return s
        })
        return settingsStore.doc.commands[id] || {}
      }
    })

    Rpc.register(registry, "rootSearch", {
      search: function(data) {
        var query = String(data && data.query || "")
        var view = data && data.view
        var ctx = searchContext()
        var sections
        if (view && view.kind === "settings") {
          sections = [{ id: "settings", title: "", rows: SettingsView.rowsFor(
            settingsStore.loaded ? settingsStore.doc.general : {}, config, query).map(toRow) }]
        } else if (view && view.kind === "processes") {
          if (processes && !processes.loading) processes.refresh()
          var needle = query.trim().toLowerCase()
          var prows = (processes ? processes.rows : []).filter(function(r) {
            return !needle || r.name.toLowerCase().indexOf(needle) >= 0 || String(r.pid).indexOf(needle) === 0
          }).map(processCandidate)
          sections = prows.length ? [{ id: "processes", title: "", rows: prows.map(toRow) }] : []
        } else if (view && view.kind === "calculator-history") sections = RootSearch.historySections(calculatorStore.doc.history, query, ctx.nowMs, Calculator.filterHistory)
        else {
          ctx.filter = String(data && data.filter || "all")
          if (query.trim() && ctx.filter === "all") ctx.calculation = calculate(query)
          sections = RootSearch.rootSections(candidates, query, ctx, deps)
          // SPEC §8.6: a Files section after Results (before the “Use ‘q’
          // with…” fallbacks), once the query is long enough to plausibly
          // be a file name.
          var fq = query.trim()
          if (ctx.filter === "all" && fq.length >= 2 && fileIndex && fileIndex.ready) {
            var matches = FileSearch.match(fileIndex.entries, fq, { limit: 30 })
            if (matches.length > 0) {
              var fileSection = { id: "files", title: "Files", rows: matches.map(function(m) { return toRow(FileSearch.candidate(m.entry)) }) }
              var at = -1, fb = -1
              for (var si = 0; si < sections.length; si++) {
                if (sections[si].id === "results") at = si
                if (sections[si].id === "fallback-commands") fb = si
              }
              if (at >= 0) sections.splice(at + 1, 0, fileSection)
              else if (fb >= 0) sections.splice(fb, 0, fileSection)
              else sections.push(fileSection)
            }
          }
        }
        return sections.map(function(s) {
          return { id: s.id, title: s.title, rows: s.rows.map(function(r) { return r.candidate }) }
        })
      },
      getActions: function(data) {
        var rowId = String(data && data.id || "")
        if (rowId.indexOf("setting:") === 0) return actionsForSetting()
        if (rowId.indexOf("process:") === 0) return actionsForProcess(processRow(String(rowId).slice("process:".length)))
        if (rowId.indexOf("file:") === 0) return FileSearch.actionsForFile()
        if (rowId === RootSearch.CALCULATOR_ID) return RootSearch.actionsFor({ kind: "calculator" })
        if (rowId.indexOf("calculator-history:") === 0) return RootSearch.actionsFor({ kind: "calculator-history" })
        var candidate = decorated(rowId)
        if (!candidate) {
          var fallback = RootSearch.FALLBACKS.filter(function(f) { return f.id === data.id })[0]
          if (!fallback) throw new Error("Unknown command " + (data && data.id))
          return RootSearch.actionsFor({ kind: "fallback", title: fallback.title })
        }
        return RootSearch.actionsFor(candidate)
      },
      getItemInfo: function(data) {
        var rowId = String(data && data.id || "")
        if (rowId.indexOf("setting:") === 0) {
          var sdef = SettingsView.find(rowId)
          if (!sdef) throw new Error("Unknown setting " + rowId)
          var sval = SettingsView.valueOf(sdef, settingsStore.loaded ? settingsStore.doc.general : {}, config)
          return [
            { label: "Setting", value: sdef.label },
            { label: "Value", value: SettingsView.format(sdef, sval) },
            { label: "Scope", value: sdef.scope === "general" ? "settings.json" : "config.json" },
            { label: "Hint", value: sdef.hint }
          ]
        }
        if (rowId.indexOf("process:") === 0) {
          var prow = processRow(String(rowId).slice("process:".length))
          if (!prow) return []
          return [
            { label: "Name", value: prow.name },
            { label: "PID", value: String(prow.pid) },
            { label: "Memory", value: prow.ws > 0 ? (Math.round(prow.ws / 1048576 * 10) / 10) + " MB" : "" },
            { label: "Path", value: prow.path || "" }
          ]
        }
        if (rowId.indexOf("file:") === 0) {
          var fpath = String(rowId).slice("file:".length)
          var hit = fileIndex ? fileIndex.entries.filter(function(e) { return e.p === fpath })[0] : null
          var infoRows = [
            { label: "Path", value: fpath },
            { label: "Kind", value: hit ? (hit.d ? "Folder" : "File") : "File" }
          ]
          if (hit && hit.m) infoRows.push({ label: "Modified", value: new Date(hit.m).toLocaleString() })
          return infoRows
        }
        var now2 = nowMs()
        if (rowId === RootSearch.CALCULATOR_ID) {
          var calc = calculate(String(data.query || ""))
          return calc ? RootSearch.aboutFor(RootSearch.calculatorCandidate(calc), now2) : []
        }
        if (rowId.indexOf("calculator-history:") === 0) {
          var entry = historyEntry(rowId)
          return entry ? RootSearch.aboutFor(RootSearch.historyCandidate(entry, now2), now2) : []
        }
        var candidate = decorated(rowId)
        if (!candidate) {
          var f = RootSearch.FALLBACKS.filter(function(x) { return x.id === rowId })[0]
          if (!f) throw new Error("Unknown command " + rowId)
          return RootSearch.aboutFor({ id: f.id, kind: "fallback", title: f.title, typeLabel: "Fallback", url: f.url }, now2)
        }
        return RootSearch.aboutFor(candidate, now2)
      },
      performAction: function(data) {
        // Destructive commands come back as a confirmation unless confirmed.
        if (!(data && data.confirmed)) {
          var confirm = RootSearch.confirmationFor(String(data && data.id || ""), String(data && data.action || "open"))
          if (confirm) return { confirm: confirm }
          // Kill Process rows confirm first (destructive, Alert.qml).
          if (String(data && data.id || "").indexOf("process:") === 0) {
            var kpid = Number(String(data.id).slice("process:".length))
            var krow = processRow(kpid)
            if (!krow) throw new Error("No such process " + kpid)
            return { confirm: { title: "Kill " + krow.name + "?",
              message: "PID " + kpid + " ends immediately. Unsaved data in " + krow.name + " is lost.",
              primary: "Kill Process", destructive: true } }
          }
        }
        var fallback = RootSearch.FALLBACKS.filter(function(f) { return f.id === (data && data.id) })[0]
        if (fallback) {
          if (fallback.id === Agent.FALLBACK_ID) {
            agentStart(data.query)
            return { pending: true }
          }
          if (host.openExternal) host.openExternal(RootSearch.fallbackUrl(fallback, data.query))
          return { close: true }
        }
        // The calculator row is the query itself, evaluated again.
        if (data && data.id === RootSearch.CALCULATOR_ID) {
          var calc = calculate(String(data.query || ""))
          if (!calc) throw new Error("Nothing to calculate")
          return calculatorAction(String(data.action || "open"), { query: calc.input, result: calc.result, copy: calc.copy, kind: calc.kind }, "")
        }
        if (data && String(data.id).indexOf("calculator-history:") === 0) {
          var entry = historyEntry(data.id)
          if (!entry) throw new Error("No such history entry")
          return calculatorAction(String(data.action || "open"), entry, entry.id)
        }
        return performAction(data)
      },
      getSearchHistory: function() { return frecencyStore.loaded ? frecencyStore.doc.searchHistory : [] }
    })

    // Names from Raycast's calculator namespace (ref 02 §2).
    Rpc.register(registry, "calculator", {
      calculate: function(data) { return calculate(String(data && data.query || "")) },
      historyGetAll: function() { return calculatorStore.loaded ? calculatorStore.doc.history : [] },
      historyDelete: function(data) { return calculatorAction("delete-entry", null, String(data && data.id || "")) },
      historyDeleteAll: function() { return calculatorAction("delete-all-entries", null, "") },
      refreshCurrencies: function() {
        if (!config.currencyRates) throw new Error("currencyRates is off in config.json")
        calculatorData.fetchRates()
        return null
      },
      getCurrencies: function() {
        var r = calculatorData.rates
        return {
          enabled: config.currencyRates,
          date: r ? r.date : null,
          base: r ? r.base : null,
          currencies: r ? Object.keys(r.rates).concat([r.base]).sort() : [],
          fetchedAt: calculatorData.ratesFetchedAt || null,
          zones: Object.keys(calculatorData.zones).length
        }
      }
    })

    Rpc.register(registry, "frecency", {
      visit: function(data) { recordVisit(String(data.id), String(data.query || "")); return null },
      get: function(data) {
        var entry = frecencyStore.doc.items[String(data && data.id || "")]
        return entry ? { anchor: entry.anchor, openedAt: entry.openedAt, score: Frecency.score(entry.anchor, nowMs() / 1000), searchTerms: entry.searchTerms } : null
      }
    })
  }

  // -------------------------------------------------------------- config
  var configWatcher = null
  function loadConfig() {
    var fs = require("fs")
    try {
      config = Schema.withConfigDefaults(JSON.parse(fs.readFileSync(paths.configFile, "utf8")))
    } catch (e) {
      if (e && e.code !== "ENOENT") log("warning", "config", "ignoring unreadable " + paths.configFile + ": " + e)
      config = Schema.withConfigDefaults(null)
    }
    calculatorData.ratesEnabled = config.currencyRates
  }

  // --------------------------------------------------------------- start
  api.start = function() {
    // mkdir -p for Paths.directoriesToCreate.
    var fs = require("fs")
    try {
      Paths.directoriesToCreate(paths).forEach(function(dir) { fs.mkdirSync(dir, { recursive: true }) })
    } catch (e) { log("error", "paths", "could not create data directories", { error: String(e && e.message || e) }) }
    directoriesReady = true

    registerServices()
    settingsStore.on("changed", function() { storeRevision++ })
    frecencyStore.on("changed", function() { storeRevision++ })
    calculatorStore.on("changed", function() { storeRevision++ })
    settingsStore.on("message", function(level, text, meta) { log(level, "store", text, meta) })
    frecencyStore.on("message", function(level, text, meta) { log(level, "store", text, meta) })
    calculatorStore.on("message", function(level, text, meta) { log(level, "store", text, meta) })
    calculatorData.on("message", function(level, text, meta) { log(level, "calculator", text, meta) })

    loadConfig()
    // Watch the config *directory* so the watcher survives a missing
    // config.json and picks up its first creation (FileView semantics).
    try {
      configWatcher = require("fs").watch(paths.config, { persistent: false }, function(event, name) {
        if (!name || String(name) === "config.json") loadConfig()
      })
    } catch (e) { /* config watch is best-effort */ }

    settingsStore.start()
    frecencyStore.start()
    calculatorStore.start()
    calculatorData.start()
    // The file index loads its cache synchronously and re-walks when stale;
    // either way the window rebuilds when it lands.
    if (fileIndex) {
      fileIndex.on("changed", function() { candidatesRevision++ })
      fileIndex.start()
    }
    if (processes) processes.on("changed", function() { candidatesRevision++ })

    if (apps) {
      apps.on("changed", scheduleRebuild)
      apps.refresh()
    }
    rebuildCandidates()
    return api
  }

  // Window visibility hook from the QML backend's notification handler:
  // refresh zones/rates when shown, cancel a pending agent check on hide.
  api.visibility = function(visible) {
    if (visible) {
      calculatorData.refresh()
      if (apps) apps.refresh()
      if (fileIndex) fileIndex.refreshIfStale()
    } else if (agentChecking) { agentChecking = false; if (agentTimer) { clearTimeout(agentTimer); agentTimer = null } }
  }

  api.dispose = function() {
    settingsStore.dispose()
    frecencyStore.dispose()
    calculatorStore.dispose()
    if (configWatcher) { try { configWatcher.close() } catch (e) {} }
  }

  return api
}

if (typeof module !== "undefined") {
  module.exports = { createBackend: createBackend, VERSION: VERSION }
}
