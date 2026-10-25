// Renderer-side host adapters: everything the backend and window need from
// the OS, wrapped so src/backend.js stays Electron-free and node-testable.
var electron = require("electron")
var childProcess = require("child_process")

var clipboard = electron.clipboard
var ipcRenderer = electron.ipcRenderer
var shell = electron.shell

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
  refocus: function() { ipcRenderer.send("refocus") },
  configChanged: function() { ipcRenderer.send("host-config-changed") },
  onVisibility: function(cb) { ipcRenderer.on("visibility", function(e, v) { cb(v) }) },
  onIpc: function(cb) { ipcRenderer.on("ipc", function(e, msg) { cb(msg) }) },
  ipcResult: function(id, value) { ipcRenderer.send("ipc-result", { id: id, value: value }) }
}
