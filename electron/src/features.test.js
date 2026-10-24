// Feature tests: unduck quicklink, file search (match + index), the
// Settings view, and the Kill Process flow — the three root-search
// additions plus the icon-critical pieces they depend on.
const test = require("node:test")
const assert = require("node:assert/strict")
const fs = require("node:fs")
const os = require("node:os")
const path = require("node:path")
const RS = require("../../plugin/core/RootSearch.js")
const FileSearch = require("../../plugin/core/FileSearch.js")
const SettingsView = require("../../plugin/core/SettingsView.js")
const { createFileIndex } = require("./file-index")
const { createBackend } = require("./backend")

// ---------------------------------------------------------------- unduck
test("unduck is a fallback row and a quicklink with the {query} contract", () => {
  const unduck = RS.FALLBACKS.find(f => f.id === "fallback:unduck")
  assert.ok(unduck, "fallback present")
  assert.equal(RS.fallbackUrl(unduck, "hello world"), "https://unduck.link?q=hello%20world")
  assert.equal(unduck.icon.codePointAt(0), 0xf0ac)          // nf-fa-globe
  const cmd = RS.BUILTINS.find(b => b.id === "builtin:unduck-search")
  assert.ok(cmd, "quicklink present")
  assert.equal(cmd.run.url, "https://unduck.link?q={query}")
  assert.deepEqual(cmd.arguments, [{ name: "query", placeholder: "Query", required: true }])
  assert.ok(cmd.keywords.includes("unduck"))
})

test("Settings and Kill Process exist as always-on root commands", () => {
  const settings = RS.BUILTINS.find(b => b.id === "builtin:settings")
  assert.equal(settings.run.push.kind, "settings")
  assert.equal(settings.glyph.codePointAt(0), 0xf113)       // nf-fa-gears
  const kill = RS.BUILTINS.find(b => b.id === "builtin:kill-process")
  assert.equal(kill.run.push.kind, "processes")
  assert.equal(kill.glyph.codePointAt(0), 0xf111)           // nf-fa-power-off
})

test("power commands: shutdown/restart confirm, sleep does not", () => {
  const sd = RS.confirmationFor("builtin:shutdown", "open")
  assert.equal(sd.destructive, true)
  assert.equal(sd.primary, "Shut Down")
  const rs = RS.confirmationFor("builtin:restart", "open")
  assert.equal(rs.destructive, true)
  assert.equal(rs.primary, "Restart")
  assert.equal(RS.confirmationFor("builtin:sleep", "open"), null)
  assert.equal(RS.confirmationFor("builtin:shutdown", "copy-path"), null)

  const builtins = Object.fromEntries(RS.BUILTINS.filter(b => b.run && b.run.power).map(b => [b.id, b.run]))
  assert.deepEqual(builtins["builtin:shutdown"], { power: "shutdown", delay: 15 })
  assert.deepEqual(builtins["builtin:restart"], { power: "restart", delay: 15 })
  assert.deepEqual(builtins["builtin:sleep"], { power: "sleep" })
  assert.equal(RS.BUILTINS.find(b => b.id === "builtin:sleep").glyph.codePointAt(0), 0xf186)
  assert.equal(RS.BUILTINS.find(b => b.id === "builtin:restart").glyph.codePointAt(0), 0xf021)
})

// ------------------------------------------------------------- file match
function ent(p, d, m) { return { p, n: path.basename(p), d, m } }

test("file matching orders name hits before path hits, then by recency", () => {
  const entries = [
    ent("C:/z/notes-report.txt", false, 1000),
    ent("C:/reporting/a.txt", false, 9000),
    ent("C:/b/report.txt", false, 5000),
    ent("C:/elsewhere/readme.md", false, 99999)
  ]
  const top = FileSearch.match(entries, "report", { limit: 10 })
  // All-in-name matches first…
  assert.equal(top[0].entry.n, "report.txt")
  assert.equal(top[0].tier, 0)
  const tiers = top.map(r => r.tier)
  assert.deepEqual(tiers, tiers.slice().sort((a, b) => a - b))  // 0 → 1 → 2
  // The path-only hit (C:/reporting/) is last among matches.
  assert.equal(top[top.length - 1].entry.n, "a.txt")
  assert.equal(top[top.length - 1].tier, 2)
})

test("every token must match, name or path, and limits apply", () => {
  const entries = [
    ent("/home/u/Desktop/quarterly report.docx", false, 1),
    ent("/home/u/nope.txt", false, 2)
  ]
  assert.equal(FileSearch.match(entries, "quarterly report", { limit: 5 }).length, 1)
  assert.equal(FileSearch.match(entries, "quarterly zebra", { limit: 5 }).length, 0)
  assert.equal(FileSearch.match(entries, "", { limit: 5 }).length, 0)
  const many = Array.from({ length: 50 }, (_, i) => ent("/d/file" + i + ".txt", false, i))
  assert.equal(FileSearch.match(many, "file", { limit: 10 }).length, 10)
})

test("file candidates carry the row shape and the three actions", () => {
  const c = FileSearch.candidate(ent("C:/Users/a/Documents/budget.xlsx", false, 1))
  assert.equal(c.id, "file:C:/Users/a/Documents/budget.xlsx")
  assert.equal(c.title, "budget.xlsx")
  assert.equal(c.subtitle, "C:/Users/a/Documents")
  assert.equal(c.typeLabel, "File")
  assert.equal(c.glyph.codePointAt(0), 0xf15b)              // nf-fa-file
  const d = FileSearch.candidate(ent("/home/u/Pics", true, 1))
  assert.equal(d.typeLabel, "Folder")
  assert.equal(d.glyph.codePointAt(0), 0xf07b)              // nf-fa-folder
  const acts = FileSearch.actionsForFile(c).map(a => a.id)
  assert.deepEqual(acts, ["open", "reveal", "copy-path"])
})

// ------------------------------------------------------------ file index
test("the index walks, excludes, hides, and round-trips its cache", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oma-cast-idx-"))
  fs.mkdirSync(path.join(root, "Documents"))
  fs.mkdirSync(path.join(root, "node_modules", "x"), { recursive: true })
  fs.mkdirSync(path.join(root, ".hidden"))
  fs.writeFileSync(path.join(root, "Documents", "notes.txt"), "hi")
  fs.writeFileSync(path.join(root, "Documents", ".secret"), "s")
  fs.writeFileSync(path.join(root, "node_modules", "x", "junk.js"), "x")
  fs.writeFileSync(path.join(root, ".hidden", "deep.txt"), "x")
  const cachePath = path.join(root, "cache", "file-index.json")

  const idx = createFileIndex({ roots: [root], home: root, cachePath })
  idx.start()
  await new Promise(r => setTimeout(r, 200))
  assert.equal(idx.ready, true)
  const names = idx.entries.map(e => e.n)
  assert.ok(names.includes("notes.txt"), "file indexed")
  assert.ok(names.includes("Documents"), "folder indexed")
  assert.ok(!names.includes("junk.js"), "node_modules excluded")
  assert.ok(!names.includes(".secret"), "hidden excluded by default")
  assert.ok(!names.includes(".hidden"), "hidden dir excluded by default")
  assert.ok(fs.existsSync(cachePath), "cache written")

  // Second instance: cache loads synchronously, no re-walk needed yet.
  const idx2 = createFileIndex({ roots: [root], home: root, cachePath })
  idx2.start()
  assert.equal(idx2.ready, true, "cache is ready synchronously")
  assert.equal(idx2.entries.length, idx.entries.length)

  // includeHidden pulls dotfiles in on the next walk.
  const idx3 = createFileIndex({ roots: [root], home: root, cachePath: "", includeHidden: true })
  idx3.start()
  await new Promise(r => setTimeout(r, 200))
  assert.ok(idx3.entries.map(e => e.n).includes(".secret"))
})

// ------------------------------------------------------------- settings
test("settings rows format, filter and cycle", () => {
  const general = { windowMode: "expanded", escapeKeyBehavior: "pop-back-or-close", navigationBindings: "emacs", rootSearchSensitivity: "medium", popToRootTimeout: 90, uiZoom: 1 }
  const config = { hotkey: "Alt+Space", keepVisibleOnFocusLoss: false, currencyRates: true, clockFormat: "auto", remToPxRate: 16, workHoursPerDay: 8, fileSearchIncludeHidden: false }

  const all = SettingsView.rowsFor(general, config, "")
  assert.ok(all.length >= 12, "every def is a row")
  const mode = all.find(r => r.id === "setting:general:windowMode")
  assert.equal(mode.typeLabel, "Expanded")
  const hot = all.find(r => r.id === "setting:config:hotkey")
  assert.equal(hot.typeLabel, "Alt+Space")

  const filtered = SettingsView.rowsFor(general, config, "hotkey")
  assert.deepEqual(filtered.map(r => r.id), ["setting:config:hotkey"])

  const modeDef = SettingsView.find("setting:general:windowMode")
  assert.equal(SettingsView.cycle(modeDef, "expanded"), "compact")
  assert.equal(SettingsView.cycle(modeDef, "compact"), "expanded")
  const boolDef = SettingsView.find("setting:config:keepVisibleOnFocusLoss")
  assert.equal(SettingsView.cycle(boolDef, false), true)
  const zoomDef = SettingsView.find("setting:general:uiZoom")
  assert.equal(SettingsView.cycle(zoomDef, 1.5), 0.8)        // presets wrap
  assert.equal(SettingsView.format(SettingsView.find("setting:general:popToRootTimeout"), 0), "Off")
  const escDef = SettingsView.find("setting:general:escapeKeyBehavior")
  assert.equal(SettingsView.format(escDef, "close-and-pop-to-root"), "Close and Pop to Root")
  assert.equal(SettingsView.find("setting:general:windowMode").scope, "general")
  assert.equal(SettingsView.find("setting:config:hotkey").scope, "config")
  assert.equal(SettingsView.find("setting:nope:nope"), null)
})

// ------------------------------------------------- backend integration
function setup() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "oma-cast-feat-"))
  const paths = {
    home: root, config: path.join(root, "config"), configFile: path.join(root, "config", "config.json"),
    scriptCommands: "", data: path.join(root, "data"), db: path.join(root, "data", "db"),
    extensions: "", extensionSupport: "", clipboard: "", notesAttachments: "",
    cache: path.join(root, "cache"), state: path.join(root, "state"), logs: "", backups: "", runtime: ""
  }
  const calls = { copy: [], openPath: [], reveal: [], configChanged: 0, power: [], cancelPower: 0 }
  const host = {
    copy: t => calls.copy.push(t),
    openPath: p => calls.openPath.push(p),
    reveal: p => calls.reveal.push(p),
    openExternal: () => {},
    pasteText: () => {},
    checkCommand: (e, cb) => cb(true),
    configChanged: () => { calls.configChanged++ },
    power: (kind, delay) => calls.power.push([kind, delay]),
    cancelPower: () => { calls.cancelPower++ }
  }
  const fileIndex = {
    entries: [
      { p: path.join(root, "Documents", "report.txt"), n: "report.txt", d: false, m: 5000 },
      { p: path.join(root, "Documents"), n: "Documents", d: true, m: 1 }
    ],
    ready: true, loading: false, lastIndexedAt: Date.now(),
    start() {}, refreshIfStale() {}, setIncludeHidden() {},
    on(ev, cb) { (this._l || (this._l = {}))[ev] = cb }
  }
  const procs = {
    rows: [
      { pid: 4242, name: "chrome", ws: 512 * 1048576, path: "C:/chrome.exe" },
      { pid: 555, name: "slack", ws: 128 * 1048576, path: "" },
      { pid: 9999, name: "oma-cast", ws: 1, path: "" }
    ],
    loading: false, at: Date.now(), killed: [], refreshed: 0,
    refresh(force) { this.refreshed++; if (force) this.at = Date.now(); return Promise.resolve(this.rows) },
    remove(pid) { this.rows = this.rows.filter(r => r.pid !== Number(pid)) },
    kill(pid) { this.killed.push(pid); return { ok: pid !== 1, message: "" } },
    on() {}
  }
  const backend = createBackend({ paths, host, fileIndex, processes: procs, apps: null }).start()
  return { backend, paths, calls, fileIndex, procs, root }
}

test("backend: Files section lands after Results and file actions dispatch", () => {
  const { backend, calls, root } = setup()
  const r = backend.callSync("rootSearch.search", { query: "report", view: null, filter: "all" })
  assert.equal(r.ok, true)
  const ids = r.data.map(s => s.id)
  assert.ok(ids.includes("files"), "Files section present: " + ids.join(","))
  if (ids.includes("results")) assert.ok(ids.indexOf("files") > ids.indexOf("results"))
  const file = r.data.find(s => s.id === "files").rows[0]
  assert.equal(file.id, "file:" + path.join(root, "Documents", "report.txt"))

  // One-character queries stay a commands/apps search (noise guard).
  const short = backend.callSync("rootSearch.search", { query: "r", view: null, filter: "all" })
  assert.ok(!short.data.some(s => s.id === "files"))

  const actions = backend.callSync("rootSearch.getActions", { id: file.id })
  assert.deepEqual(actions.data.map(a => a.id), ["open", "reveal", "copy-path"])
  const open = backend.callSync("rootSearch.performAction", { id: file.id, action: "open", query: "report", confirmed: true })
  assert.equal(open.data.close, true)
  assert.deepEqual(calls.openPath, [path.join(root, "Documents", "report.txt")])
  const copy = backend.callSync("rootSearch.performAction", { id: file.id, action: "copy-path", query: "report", confirmed: true })
  assert.deepEqual(calls.copy, [path.join(root, "Documents", "report.txt")])
  const info = backend.callSync("rootSearch.getItemInfo", { id: file.id, query: "" })
  assert.equal(info.data[0].label, "Path")
  backend.dispose()
})

test("backend: the Settings view lists, cycles and persists values", () => {
  const { backend, paths, calls } = setup()
  const r = backend.callSync("rootSearch.search", { query: "", view: { kind: "settings", title: "Settings" }, filter: "all" })
  assert.equal(r.ok, true)
  const rows = r.data[0].rows
  assert.ok(rows.some(x => x.id === "setting:general:windowMode"))
  assert.ok(rows.some(x => x.id === "setting:config:hotkey"))

  // ↵ cycles windowMode through the validated store path.
  const cycle = backend.callSync("rootSearch.performAction", { id: "setting:general:windowMode", action: "open", query: "", confirmed: true })
  assert.match(cycle.data.toast.title, /Window Mode: Compact/)
  const general = backend.callSync("settings.getGeneralSettings", null)
  assert.equal(general.data.windowMode, "compact")

  // Hotkey writes config.json and pokes main to re-register.
  const hot = backend.callSync("rootSearch.performAction", { id: "setting:config:hotkey", action: "open", query: "", confirmed: true })
  assert.match(hot.data.toast.title, /Global Hotkey: Alt\+K/)
  const written = JSON.parse(fs.readFileSync(paths.configFile, "utf8"))
  assert.equal(written.hotkey, "Alt+K")
  assert.equal(calls.configChanged, 1)

  const actions = backend.callSync("rootSearch.getActions", { id: "setting:config:hotkey" })
  assert.deepEqual(actions.data.map(a => a.id), ["open"])
  const info = backend.callSync("rootSearch.getItemInfo", { id: "setting:general:uiZoom", query: "" })
  assert.equal(info.data[2].value, "settings.json")
  backend.dispose()
})

test("backend: Kill Process confirms, kills, removes and toasts", () => {
  const { backend, procs } = setup()
  const r = backend.callSync("rootSearch.search", { query: "", view: { kind: "processes", title: "Kill Process" }, filter: "all" })
  assert.equal(r.ok, true)
  const rows = r.data[0].rows
  assert.equal(rows[0].id, "process:4242")                 // biggest working set first
  assert.equal(rows[0].typeLabel, "512 MB")
  assert.equal(rows[0].subtitle, "PID 4242")

  // Actions come first, while the rows are still live: kill, reveal only
  // when a path exists, copy pid.
  const actsChrome = backend.callSync("rootSearch.getActions", { id: "process:4242" })
  assert.deepEqual(actsChrome.data.map(a => a.id), ["open", "reveal", "copy-pid"])
  const actsSlack = backend.callSync("rootSearch.getActions", { id: "process:555" })
  assert.deepEqual(actsSlack.data.map(a => a.id), ["open", "copy-pid"])

  // Enter asks first (destructive alert).
  const confirm = backend.callSync("rootSearch.performAction", { id: "process:4242", action: "open", query: "", confirmed: false })
  assert.equal(confirm.ok, true)
  assert.equal(confirm.data.confirm.destructive, true)
  assert.match(confirm.data.confirm.title, /Kill chrome\?/)
  assert.equal(procs.killed.length, 0, "nothing killed before confirmation")

  const killed = backend.callSync("rootSearch.performAction", { id: "process:4242", action: "open", query: "", confirmed: true })
  assert.match(killed.data.toast.title, /chrome \(4242\) killed/)
  assert.deepEqual(procs.killed, [4242])
  assert.ok(!procs.rows.some(x => x.pid === 4242), "row removed optimistically")

  const pidCopy = backend.callSync("rootSearch.performAction", { id: "process:555", action: "copy-pid", query: "", confirmed: true })
  assert.match(pidCopy.data.toast.title, /PID 555 copied/)

  // Filtering by name and by pid.
  const filtered = backend.callSync("rootSearch.search", { query: "sla", view: { kind: "processes" }, filter: "all" })
  assert.deepEqual(filtered.data[0].rows.map(x => x.pid), [555])
  const byPid = backend.callSync("rootSearch.search", { query: "9999", view: { kind: "processes" }, filter: "all" })
  assert.deepEqual(byPid.data[0].rows.map(x => x.pid), [9999])
  backend.dispose()
})

test("backend: shutdown schedules with a cancellable toast, sleep closes", () => {
  const { backend, calls } = setup()

  // Unconfirmed → the destructive alert.
  const confirm = backend.callSync("rootSearch.performAction", { id: "builtin:shutdown", action: "open", query: "", confirmed: false })
  assert.equal(confirm.data.confirm.destructive, true)
  assert.deepEqual(calls.power, [])

  // Confirmed → shutdown.exe /s /t 15 scheduled, toast carries Cancel.
  const sd = backend.callSync("rootSearch.performAction", { id: "builtin:shutdown", action: "open", query: "", confirmed: true })
  assert.equal(sd.data.toast.title, "Shut Down in 15 seconds")
  assert.deepEqual(calls.power, [["shutdown", 15]])
  const cancel = sd.data.toast.actions.find(a => a.id === "cancel-power")
  assert.equal(cancel.call.method, "system.cancelPowerShutdown")
  const cancelled = backend.callSync(cancel.call.method, null)
  assert.equal(cancelled.ok, true)
  assert.equal(calls.cancelPower, 1)

  // Restart uses /r with the same schedule.
  const rs = backend.callSync("rootSearch.performAction", { id: "builtin:restart", action: "open", query: "", confirmed: true })
  assert.equal(rs.data.toast.title, "Restart in 15 seconds")
  assert.deepEqual(calls.power[1], ["restart", 15])

  // Sleep: no confirmation, closes the window with a HUD line.
  const sl = backend.callSync("rootSearch.performAction", { id: "builtin:sleep", action: "open", query: "", confirmed: false })
  assert.equal(sl.data.close, true)
  assert.equal(sl.data.hud, "Sleeping…")
  assert.deepEqual(calls.power[2], ["sleep", 0])

  // Power actions never record frecency (they stay out of Suggestions).
  const freq = backend.callSync("frecency.get", { id: "builtin:shutdown" })
  assert.equal(freq.data, null)
  backend.dispose()
})
