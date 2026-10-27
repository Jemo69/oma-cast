// Renderer-side host adapters: everything the backend and window need from
// the OS, wrapped so src/backend.js stays Electron-free and node-testable.
var electron = require("electron")
var childProcess = require("child_process")

var clipboard = electron.clipboard
var ipcRenderer = electron.ipcRenderer
var shell = electron.shell

// "Take me there": main answers whether <exe> already has a window (it
// also drops the close-time focus hand-back so the app keeps focus).
// cb is settled exactly once — by the reply, an error, or the 2.5 s
// safety timer — so a launch can never be swallowed. [D]
var focusSeq = 0
var focusPending = {}
if (ipcRenderer && typeof ipcRenderer.on === "function") {
  ipcRenderer.on("focus-app-result", function(e, res) {
    var fn = res && focusPending[res.id]
    if (fn) fn(!!res.taken)
  })
}

module.exports = {
  copy: function(text) { clipboard.writeText(String(text === undefined || text === null ? "" : text)) },
  readText: function() { return clipboard.readText() },
  openExternal: function(url) { shell.openExternal(String(url)) },
  // shell.openPath opens files and folders with the registered handler;
  // the promise resolves to "" on success or an error string. Fire-and-
  // forget from the backend's sync API.
  openPath: function(p) { shell.openPath(String(p)) },
  // Reveal in Explorer: selects the file in its parent folder. [D]
  reveal: function(p) {
    try {
      childProcess.spawn("explorer.exe", ["/select,", String(p)], { windowsHide: true, stdio: "ignore" }).unref()
    } catch (e) {}
  },

  // omarchy-clipboard-paste-text equivalent: set the clipboard, ask main
  // to hide the window and send Ctrl+V to the window underneath.
  pasteText: function(text) {
    clipboard.writeText(String(text === undefined || text === null ? "" : text))
    ipcRenderer.send("host-paste")
  },

  // The OSD equivalent after a successful close (SPEC fork HUD).
  hud: function(text) { ipcRenderer.send("host-hud", String(text || "")) },

  // The AgentLauncher preflight, question-free and bounded (5 s in main).
  checkCommand: function(exe, cb) {
    childProcess.execFile("where.exe", [String(exe)], { timeout: 5000, windowsHide: true }, function(err) {
      cb(!err, err ? String(exe) + " was not found on PATH" : "")
    })
  },

  // Util.execArgv equivalent: a command line through cmd, detached.
  execDetached: function(commandLine) {
    try {
      childProcess.spawn(String(commandLine), { shell: true, detached: true, stdio: "ignore", windowsHide: true }).unref()
    } catch (e) {}
  },

  // Windows power actions. shutdown/restart schedule 15 s out so the
  // toast's Cancel (shutdown /a) can abort; sleep is delayed until the
  // window has unmap. Uses PowerShell SetSuspendState('Suspend') so true
  // sleep is invoked even when hibernation is enabled (rundll32 SetSuspendState
  // erroneously hibernates due to a calling-convention mismatch). [D]
  power: function(kind, delay) {
    var d = Math.max(0, Number(delay) || 0)
    function run(bin, args) {
      try {
        childProcess.spawn(bin, args, { windowsHide: true, stdio: "ignore", detached: false }).unref()
      } catch (e) {}
    }
    if (kind === "shutdown") run("shutdown.exe", ["/s", "/t", String(d), "/c", "oma-cast"])
    else if (kind === "restart") run("shutdown.exe", ["/r", "/t", String(d), "/c", "oma-cast"])
    else if (kind === "sleep") {
      setTimeout(function() {
        run("powershell.exe", [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-Command",
          "Add-Type -AssemblyName System.Windows.Forms; [System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)"
        ])
      }, 400)
    }
  },
  cancelPower: function() {
    try {
      childProcess.spawn("shutdown.exe", ["/a"], { windowsHide: true, stdio: "ignore" }).unref()
    } catch (e) {}
  },

  dismiss: function() { ipcRenderer.send("dismiss") },
  // Card geometry lives in the renderer (ui/app.js layout()); main owns
  // the OS window, so the renderer reports its size here. Best-effort:
  // plain node (unit tests) has no bridge. [D]
  resizeWindow: function(w, h) { try { ipcRenderer.send("resize-window", { width: w, height: h }) } catch (e) {} },
  focusAppWindow: function(name, cb) {
    var id = ++focusSeq
    var done = false
    var timer = setTimeout(function() { settle(false) }, 2500)
    function settle(taken) {
      if (done) return
      done = true
      clearTimeout(timer)
      if (focusPending[id]) delete focusPending[id]
      cb(taken)
    }
    focusPending[id] = settle
    try {
      ipcRenderer.send("host-focus-app", { id: id, name: String(name || "") })
    } catch (e) { settle(false) }
  },
  refocus: function() { ipcRenderer.send("refocus") },
  configChanged: function() { ipcRenderer.send("host-config-changed") },
  onVisibility: function(cb) { ipcRenderer.on("visibility", function(e, v) { cb(v) }) },
  onIpc: function(cb) { ipcRenderer.on("ipc", function(e, msg) { cb(msg) }) },
  ipcResult: function(id, value) { ipcRenderer.send("ipc-result", { id: id, value: value }) }
}
