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

  dismiss: function() { ipcRenderer.send("dismiss") },
  refocus: function() { ipcRenderer.send("refocus") },
  configChanged: function() { ipcRenderer.send("host-config-changed") },
  onVisibility: function(cb) { ipcRenderer.on("visibility", function(e, v) { cb(v) }) },
  onIpc: function(cb) { ipcRenderer.on("ipc", function(e, msg) { cb(msg) }) },
  ipcResult: function(id, value) { ipcRenderer.send("ipc-result", { id: id, value: value }) }
}
