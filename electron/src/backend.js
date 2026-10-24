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
var jsonStore = require("./json-store")
var calcData = require("./calculator-data")

var VERSION = "0.1.0"

function createBackend(opts) {
  opts = opts || {}
  var paths = opts.paths || Paths.resolveWindows(opts.env || function(k) { return process.env[k] })
  var host = opts.host || {}
  var apps = opts.apps
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
    get loading() { return !!((apps && apps.loading) || agentChecking) },
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

  function performAction(data) {
    var id = String(data && data.id || "")
    var action = String(data && data.action || "open")
    var query = String(data && data.query || "").trim()
    var candidate = decorated(id)
    if (!candidate) throw new Error("Unknown command " + id)

    if (action === "open") {
      switch (candidate.kind) {
        case "app":
          recordVisit(id, query)
          if (apps) apps.launch(candidate.appId)
          return { close: true }
        case "builtin":
          if (candidate.run.url) {
            var values = (data && data.arguments) || {}
            var missing = RootSearch.missingArgument(candidate.arguments, values)
            if (missing >= 0) throw new Error("Type a " + candidate.arguments[missing].placeholder.toLowerCase() + " first")
            recordVisit(id, query)
            if (host.openExternal) host.openExternal(RootSearch.fillArguments(candidate.run.url, values))
            return { close: true }
          }
          recordVisit(id, query)
          if (candidate.run.push) return { push: candidate.run.push }
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
      getPaths: function() { return paths }
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
        if (view && view.kind === "calculator-history") sections = RootSearch.historySections(calculatorStore.doc.history, query, ctx.nowMs, Calculator.filterHistory)
        else {
          ctx.filter = String(data && data.filter || "all")
          if (query.trim() && ctx.filter === "all") ctx.calculation = calculate(query)
          sections = RootSearch.rootSections(candidates, query, ctx, deps)
        }
        return sections.map(function(s) {
          return { id: s.id, title: s.title, rows: s.rows.map(function(r) { return r.candidate }) }
        })
      },
      getActions: function(data) {
        var rowId = String(data && data.id || "")
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
    if (visible) { calculatorData.refresh(); if (apps) apps.refresh() }
    else if (agentChecking) { agentChecking = false; if (agentTimer) { clearTimeout(agentTimer); agentTimer = null } }
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
