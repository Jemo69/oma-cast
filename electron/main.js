// oma-cast Electron main process: the host layer that Quickshell provided
// on Omarchy. One frameless transparent overlay window covering the
// monitor under the cursor, a global hotkey, a named-pipe CLI endpoint
// (the IpcHandler twin), clipboard-paste orchestration and HUD toasts.
// Everything else — backend, stores, ranking, the UI — lives in the
// renderer, mirroring the single-engine QML design. [D]
const { app, BrowserWindow, globalShortcut, ipcMain, screen, Notification } = require("electron")
const path = require("path")
const fs = require("fs")
const net = require("net")
const { execFile } = require("child_process")

const APP_ID = "typecraft.oma-cast"
const PIPE_NAME = "\\\\.\\pipe\\oma-cast"

// VK_CONTROL down/up + VK_V down/up: Ctrl+V into whatever window had focus
// when ours unmaps. The same contract as omarchy-clipboard-paste-text. [D]
const PASTE_SCRIPT = [
  "Add-Type '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);' -Namespace Win32 -Name Input",
  "[Win32.Input]::keybd_event(0x11, 0, 0, [UIntPtr]::Zero)",
  "[Win32.Input]::keybd_event(0x56, 0, 0, [UIntPtr]::Zero)",
  "[Win32.Input]::keybd_event(0x56, 0, 2, [UIntPtr]::Zero)",
  "[Win32.Input]::keybd_event(0x11, 0, 2, [UIntPtr]::Zero)"
].join("; ")

let win = null
let isOpen = false
let forwardSeq = 0
const forwardPending = new Map()

// Same layout rules as plugin/core/Paths.js on Windows. [D]
function paths() {
  const Paths = require("../plugin/core/Paths.js")
  return Paths.resolveWindows(function(name) { return process.env[name] })
}
function readConfig() {
  try {
    return Object.assign({ hotkey: "Alt+Space", keepVisibleOnFocusLoss: false },
      JSON.parse(fs.readFileSync(paths().configFile, "utf8")))
  } catch (e) { return { hotkey: "Alt+Space", keepVisibleOnFocusLoss: false } }
}

function send(channel, payload) {
  if (win && !win.isDestroyed()) win.webContents.send(channel, payload)
}

function createWindow() {
  win = new BrowserWindow({
    show: false,
    frame: false,
    transparent: true,
    resizable: false,
    movable: false,
    hasShadow: false,
    skipTaskbar: true,
    alwaysOnTop: true,
    fullscreenable: false,
    webPreferences: {
      nodeIntegration: true,
      contextIsolation: false,
      spellcheck: false,
      backgroundThrottling: false
    }
  })
  // Layer-shell Overlay equivalent: above normal windows, no taskbar entry.
  win.setAlwaysOnTop(true, "screen-saver")
  win.setMenuBarVisibility(false)
  win.loadFile(path.join(__dirname, "ui", "index.html"))

  // Focus loss dismisses unless keepVisibleOnFocusLoss (the config key
  // Backend.qml gates its click-to-dismiss on). Clicks on the transparent
  // area are handled in the renderer. [D]
  win.on("blur", function() { if (!readConfig().keepVisibleOnFocusLoss) hide() })
  win.on("closed", function() { win = null })
}

// The card sits on the monitor under the mouse, like Raycast's
// "mouse-screen" presentation (settings general.windowPresentationMode).
function placeOnMouseScreen() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  win.setBounds(display.bounds)
}

function show() {
  if (!win) return
  placeOnMouseScreen()
  win.show()
  win.focus()
  isOpen = true
  send("visibility", true)
}
function hide() {
  if (!win || !isOpen) return
  win.hide()
  isOpen = false
  send("visibility", false)
}
function toggle() { if (isOpen) hide(); else show() }

// ------------------------------------------------------------- CLI pipe
function forwardToRenderer(kind, payload, reply) {
  if (!win) return reply({ ok: false, error: "window not ready" })
  const id = ++forwardSeq
  forwardPending.set(id, reply)
  send("ipc", { kind: kind, id: id, payload: payload })
}
function handlePipeLine(line, sock) {
  let req = null
  try { req = JSON.parse(line) } catch (e) { sock.end(JSON.stringify({ ok: false, error: "request is not JSON" }) + "\n"); return }
  const reply = function(value) { try { sock.end(JSON.stringify(value) + "\n") } catch (e) {} }
  switch (String(req.method || "")) {
    case "toggle": toggle(); reply({ ok: true, data: isOpen ? "shown" : "hidden" }); break
    case "show": show(); reply({ ok: true, data: "shown" }); break
    case "hide": hide(); reply({ ok: true, data: "hidden" }); break
    case "isOpen": reply({ ok: true, data: isOpen ? "true" : "false" }); break
    case "ping": reply({ ok: true, data: "ok" }); break
    case "run": forwardToRenderer("run", String(req.commandId || ""), reply); break
    case "call": forwardToRenderer("call", req, reply); break
    default: reply({ ok: false, error: "Unknown method " + req.method })
  }
}
function servePipe() {
  const server = net.createServer(function(sock) {
    let buf = ""
    sock.on("data", function(chunk) {
      buf += String(chunk)
      var i
      while ((i = buf.indexOf("\n")) >= 0) {
        const line = buf.slice(0, i)
        buf = buf.slice(i + 1)
        if (line.trim()) handlePipeLine(line, sock)
      }
    })
    sock.on("error", function() {})
  })
  server.listen(PIPE_NAME)
}

// ---------------------------------------------------------------- wiring
ipcMain.on("host-paste", function() {
  // Renderer already wrote the clipboard; give the window time to unmap
  // before the keystroke goes to the window underneath.
  hide()
  setTimeout(function() {
    execFile("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-Command", PASTE_SCRIPT],
      { windowsHide: true, timeout: 5000 },
      function() {})
  }, 150)
})
ipcMain.on("host-hud", function(e, text) {
  new Notification({ title: "oma-cast", body: String(text || ""), silent: true }).show()
})
ipcMain.on("dismiss", function() { hide() })
ipcMain.on("host-config-changed", function() { registerHotkey() })
ipcMain.on("ipc-result", function(e, res) {
  const fn = forwardPending.get(res.id)
  if (fn) { forwardPending.delete(res.id); fn(res.value) }
})

function registerHotkey() {
  globalShortcut.unregisterAll()
  const key = String(readConfig().hotkey || "Alt+Space")
  try {
    if (!globalShortcut.register(key, toggle)) console.error("[oma-cast] could not register hotkey " + key)
  } catch (e) { console.error("[oma-cast] hotkey " + key + " failed: " + e) }
}

const gotLock = app.requestSingleInstanceLock()
if (!gotLock) {
  // Second process: `oma-cast toggle` (or the packaged exe run again) →
  // the running instance flips; our argv tells it what was asked. The
  // default action is toggle; --show/--hide/--run/--call come through the
  // pipe instead, so a bare second instance just toggles.
  app.quit()
} else {
  app.on("second-instance", function() { toggle() })
  app.setAppUserModelId(APP_ID)

  app.whenReady().then(function() {
    createWindow()
    registerHotkey()
    servePipe()
    if (process.argv.includes("--show")) show()
    else if (process.argv.includes("--toggle")) toggle()
  })
}

app.on("will-quit", function() { globalShortcut.unregisterAll() })
app.on("window-all-closed", function() { /* stay resident for the hotkey */ })
