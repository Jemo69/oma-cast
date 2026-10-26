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
const { execFile, spawn } = require("child_process")

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

// Windows keeps foreground activation locked: a freshly shown frameless
// window is often painted WITHOUT keyboard focus, so keystrokes stay in
// the previous app. The documented way out is a dummy ALT input event
// (releases the lock) followed by SetForegroundWindow with our real HWND.
// Only used when the plain focus() attempt lost. [D]
const FOCUS_SCRIPT = [
  "Add-Type '[DllImport(\"user32.dll\")] public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo); public static extern bool SetForegroundWindow(IntPtr hWnd);' -Namespace Win32 -Name Input",
  "[Win32.Input]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)",
  "[Win32.Input]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)",
  "[Win32.Input]::SetForegroundWindow([IntPtr]([Int64]$args[0]))"
].join("; ")

// The resident twin of FOCUS_SCRIPT: one PowerShell process answers
// `ping` / `getfg` / `focus <hwnd>` / `app <exe>` on stdin, one reply per
// line. Spawning a fresh process per question costs ~300 ms — far too much
// to sit between the hotkey and the window mapping. `app` is the "take me
// there" lookup: process → its window → restore + focus. [D]
const FOCUS_HELPER_SCRIPT = [
  "Add-Type '[DllImport(\"user32.dll\")] public static extern IntPtr GetForegroundWindow(); public static extern bool SetForegroundWindow(IntPtr hWnd); public static extern bool IsWindow(IntPtr hWnd); public static extern bool IsIconic(IntPtr hWnd); public static extern bool ShowWindow(IntPtr hWnd, int nCmdShow); public static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, UIntPtr dwExtraInfo);' -Namespace Win32 -Name Input",
  // One place for restore + focus + the foreground-lock ALT fallback: a
  // minimized window must come back (SW_RESTORE = 9) before focusing. [D]
  "function FocusHwnd([IntPtr]$h) {",
  "  if (-not [Win32.Input]::IsWindow($h)) { return $false }",
  "  if ([Win32.Input]::IsIconic($h)) { [void][Win32.Input]::ShowWindow($h, 9) }",
  "  $ok = [Win32.Input]::SetForegroundWindow($h)",
  "  if (-not $ok) {",
  "    # Windows' foreground lock refused: a dummy ALT input releases it. [D]",
  "    [Win32.Input]::keybd_event(0x12, 0, 0, [UIntPtr]::Zero)",
  "    [Win32.Input]::keybd_event(0x12, 0, 2, [UIntPtr]::Zero)",
  "    $ok = [Win32.Input]::SetForegroundWindow($h)",
  "  }",
  "  return $ok",
  "}",
  "while ($true) {",
  "  $line = [Console]::In.ReadLine()",
  "  if ($null -eq $line) { break }",
  "  try {",
  "    if ($line -eq 'ping') {",
  "      [Console]::Out.WriteLine('pong')",
  "    } elseif ($line -eq 'getfg') {",
  "      [Console]::Out.WriteLine('fg ' + [Int64][Win32.Input]::GetForegroundWindow())",
  "    } elseif ($line -match '^focus [0-9]+$') {",
  "      [Console]::Out.WriteLine('ok ' + [int](FocusHwnd ([IntPtr]([Int64]($line.Substring(6))))))",
  "    } elseif ($line -match '^app .+') {",
  "      # Already running with a window? Bring it up instead of a second",
  "      # instance; a tray-only process (MainWindowHandle 0) still launches. [D]",
  "      $w = $null",
  "      try { $w = Get-Process -Name ($line.Substring(4)) -ErrorAction SilentlyContinue | Where-Object { $_.MainWindowHandle -ne 0 } | Select-Object -First 1 } catch {}",
  "      if ($w) { [Console]::Out.WriteLine('ok ' + [int](FocusHwnd ([IntPtr]($w.MainWindowHandle)))) }",
  "      else { [Console]::Out.WriteLine('none') }",
  "    } else {",
  "      [Console]::Out.WriteLine('err')",
  "    }",
  "  } catch {",
  "    [Console]::Out.WriteLine('err')",
  "  }",
  "  [Console]::Out.Flush()",
  "}"
].join("\n")

// ------------------------------------------------------------------ logs
// Everything the app prints (main + renderer console) lands in
// %LOCALAPPDATA%\oma-cast\logs\main.log so a broken install can be
// diagnosed from one file. [D]
let logStream = null
function logFileSetup() {
  try {
    const logDir = path.join(paths().logs)
    fs.mkdirSync(logDir, { recursive: true })
    const file = path.join(logDir, "main.log")
    try {
      if (fs.existsSync(file) && fs.statSync(file).size > 1024 * 1024) {
        fs.renameSync(file, file + ".old")
      }
    } catch (e) { /* rotation is best-effort */ }
    logStream = fs.createWriteStream(file, { flags: "a" })
  } catch (e) { logStream = null }
}
function logLine(line) {
  const text = "[oma-cast-main] " + new Date().toISOString() + " " + String(line) + "\n"
  try { process.stdout.write(text) } catch (e) {}
  if (logStream) { try { logStream.write(text) } catch (e) {} }
}

let win = null
let isOpen = false
let hadFocus = false
let forwardSeq = 0
const forwardPending = new Map()

// The window that held the foreground when the launcher mapped, as an
// HWND string — handed back when the launcher closes. Sampled at show,
// cleared on blur (the OS already gave focus to whatever was clicked). [D]
let prevFh = null
let focusHelper = null
let focusHelperWarm = false
let focusHelperQueue = []
let focusHelperBuf = ""

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

// ------------------------------------------------------- focus helper
// Replies come back in order; every ask owns a queue slot for its whole
// life, so a timed-out slot still swallows its late reply and the next
// answer stays aligned. Any reply proves the child booted → warm. [D]
function focusHelperStart() {
  if (focusHelper) return focusHelper
  try {
    focusHelper = spawn("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", FOCUS_HELPER_SCRIPT],
      { windowsHide: true, stdio: ["pipe", "pipe", "ignore"] })
  } catch (e) {
    focusHelper = null
    logLine("focus helper could not start: " + e)
    return null
  }
  var proc = focusHelper
  proc.stdout.setEncoding("utf8")
  proc.stdout.on("data", function(chunk) {
    focusHelperBuf += String(chunk)
    var i
    while ((i = focusHelperBuf.indexOf("\n")) >= 0) {
      var line = focusHelperBuf.slice(0, i).trim()
      focusHelperBuf = focusHelperBuf.slice(i + 1)
      if (!line) continue
      focusHelperWarm = true
      var cb = focusHelperQueue.shift()
      if (cb) cb(line)
    }
  })
  proc.on("error", function(err) {
    logLine("focus helper error: " + err)
    if (focusHelper === proc) { focusHelper = null; focusHelperWarm = false }
    flushFocusHelper()
  })
  proc.on("exit", function(code) {
    logLine("focus helper exited (" + code + ")")
    if (focusHelper === proc) { focusHelper = null; focusHelperWarm = false }
    flushFocusHelper()
  })
  return proc
}
function flushFocusHelper() {
  focusHelperBuf = ""
  var pending = focusHelperQueue
  focusHelperQueue = []
  for (var i = 0; i < pending.length; i++) pending[i](null)
}
function focusHelperAsk(command, timeoutMs, cb) {
  var proc = focusHelperStart()
  if (!proc || !proc.stdin || !proc.stdin.writable) return cb(null)
  var settled = false
  function settle(line) {
    if (settled) return
    settled = true
    clearTimeout(timer)
    cb(line)
  }
  var timer = setTimeout(function() {
    settle(null)
    logLine("focus helper timeout: " + command)
  }, timeoutMs || 500)
  focusHelperQueue.push(settle)
  try {
    proc.stdin.write(command + "\n")
  } catch (e) {
    logLine("focus helper write failed: " + e)
    settle(null)
  }
}
// Warm-up from whenReady: once the child has answered, the first show
// knows a capture can be waited on. Retries once a second while alive. [D]
function pingFocusHelper() {
  focusHelperAsk("ping", 3000, function(line) {
    if (line) { logLine("focus helper ready"); return }
    if (focusHelper) setTimeout(pingFocusHelper, 1000)
  })
}
function ourHwnd() {
  try {
    if (!win || win.isDestroyed()) return "0"
    return String(win.getNativeWindowHandle().readBigInt64LE())
  } catch (e) { return "0" }
}
// Sample the window that currently holds the foreground. Waited on only
// when the helper is proven warm (one roundtrip, ~10 ms): focus must
// never wait on us — a cold helper simply means no hand-back at close
// and stock Windows behaviour instead. [D]
function capturePreviousFocus(done) {
  prevFh = null
  if (!focusHelperWarm) { if (done) done(); return }
  focusHelperAsk("getfg", 250, function(line) {
    if (line && line.indexOf("fg ") === 0) {
      var h = line.slice(3).trim()
      if (/^[0-9]+$/.test(h) && h !== "0" && h !== ourHwnd()) {
        prevFh = h
        logLine("foreground before show: " + h)
      }
    }
    if (done) done()
  })
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

  win.on("focus", function() { hadFocus = true; logLine("window focused") })
  win.webContents.on("console-message", function(e, level, message) {
    logLine("[renderer:" + level + "] " + message)
  })
  win.webContents.on("did-finish-load", function() { logLine("renderer loaded") })

  // Focus loss dismisses unless keepVisibleOnFocusLoss (the config key
  // Backend.qml gates its click-to-dismiss on). Clicks on the transparent
  // area are handled in the renderer. [D]
  win.on("blur", function() {
    logLine("window blurred (had focus: " + hadFocus + ")")
    // We no longer hold the foreground: whatever got clicked already has
    // it, so there is nothing to hand back on the hide below. [D]
    prevFh = null
    if (!readConfig().keepVisibleOnFocusLoss) hide()
  })
  win.on("closed", function() { win = null })
}

// The card sits on the monitor under the mouse, like Raycast's
// "mouse-screen" presentation (settings general.windowPresentationMode).
function placeOnMouseScreen() {
  const display = screen.getDisplayNearestPoint(screen.getCursorScreenPoint())
  win.setBounds(display.bounds)
}

// Break the Windows foreground lock when plain focus() lost: ALT tap +
// SetForegroundWindow(HWND). Detached; ~250 ms, fallback path only — the
// hotkey path normally focuses immediately.
function stealForeground() {
  if (!win || win.isDestroyed()) return
  let handle = "0"
  try { handle = String(win.getNativeWindowHandle().readBigInt64LE()) } catch (e) {}
  execFile("powershell.exe",
    ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", FOCUS_SCRIPT, handle],
    { windowsHide: true, timeout: 5000 },
    function(err) {
      const focused = !!(win && !win.isDestroyed() && win.isFocused())
      logLine("foreground steal " + (err ? "failed: " + err : "done") + " (focused now: " + focused + ")")
    })
}

function grabKeyboardFocus() {
  if (!win || win.isDestroyed()) return
  win.moveTop()
  win.focus()
  try { win.webContents.focus() } catch (e) {}
  // Windows answers asynchronously; check twice, then force it.
  setTimeout(function() {
    if (!win || win.isDestroyed() || !isOpen || win.isFocused()) return
    win.moveTop()
    win.focus()
    setTimeout(function() {
      if (!win || win.isDestroyed() || !isOpen || win.isFocused()) return
      logLine("focus refused by Windows, stealing foreground")
      stealForeground()
    }, 60)
  }, 30)
}

function show() {
  if (!win) return
  placeOnMouseScreen()
  var wasOpen = isOpen
  hadFocus = false
  // Map WITHOUT activating: the window we took the foreground from keeps
  // it for the capture below, which must sample *them*, not us — then
  // grabKeyboardFocus takes it as it always did. [D]
  win.showInactive()
  isOpen = true
  logLine("shown " + JSON.stringify(win.getBounds()))
  send("visibility", true)
  // Already mapped (pipe "show" while open): keep the sample we hold.
  if (wasOpen) { grabKeyboardFocus(); return }
  capturePreviousFocus(function() {
    if (!win || win.isDestroyed() || !isOpen) return
    grabKeyboardFocus()
  })
}
// Close: hand the foreground back to the window we took it from — but
// only while we still hold it. On blur prevFh was already cleared (the
// OS gave focus to whatever the user clicked; stealing it back would
// fight them). afterFocus runs once the hand-back has landed, so Ctrl+V
// from the paste path reaches the right window. [D]
function hide(afterFocus) {
  if (!win || !isOpen) { if (afterFocus) afterFocus(); return }
  var target = (prevFh && win.isFocused() && prevFh !== ourHwnd()) ? prevFh : null
  prevFh = null
  win.hide()
  isOpen = false
  send("visibility", false)
  if (!target) { if (afterFocus) afterFocus(); return }
  focusHelperAsk("focus " + target, 400, function(line) {
    logLine("focus hand-back to " + target + ": " + (line || "no answer"))
    if (afterFocus) afterFocus()
  })
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
  // Renderer already wrote the clipboard; hide, wait for the foreground
  // hand-back to land (and at least the 150 ms unmap beat), then Ctrl+V
  // — the keystroke must reach the window we took focus from. [D]
  var t0 = Date.now()
  hide(function() {
    setTimeout(function() {
      execFile("powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", PASTE_SCRIPT],
        { windowsHide: true, timeout: 5000 },
        function() {})
    }, Math.max(0, 150 - (Date.now() - t0)))
  })
})
ipcMain.on("host-hud", function(e, text) {
  new Notification({ title: "oma-cast", body: String(text || ""), silent: true }).show()
})
ipcMain.on("dismiss", function() { hide() })
// ↵ on an app row: "take me there" — ask whether that program already has
// a window (the helper does process → hwnd → restore + focus). Clearing
// prevFh HERE is what keeps the close that follows from handing focus
// back to the previous window: the app is getting it, by our hand. [D]
ipcMain.on("host-focus-app", function(e, req) {
  var id = req ? req.id : null
  var reply = function(taken) { send("focus-app-result", { id: id, taken: !!taken }) }
  prevFh = null
  // Sanitised, not whitelisted: every exe name is legal — only the line
  // breaks that would break the helper's stdin protocol are not. The old
  // [A-Za-z0-9 ._+-] whitelist silently answered "launch" for names with
  // e.g. parentheses. [D]
  var name = String(req && req.name || "").replace(/[\r\n]/g, "").trim().slice(0, 120)
  if (!name) { logLine("app switch: request without an exe name"); return reply(false) }
  logLine("app switch: " + name)
  focusHelperAsk("app " + name, 2000, function(line) {
    logLine("app switch answer: " + name + " → " + (line || "no answer (helper cold or dead)"))
    reply(!!line && line.indexOf("ok") === 0)
  })
})
// The renderer's second opinion: document.hasFocus() is authoritative for
// keyboard routing and can be false even when win.isFocused() is true.
ipcMain.on("refocus", function() {
  if (!isOpen) return
  logLine("renderer reports no keyboard focus")
  stealForeground()
})
ipcMain.on("host-config-changed", function() { registerHotkey(); applyOpenAtLogin() })
ipcMain.on("ipc-result", function(e, res) {
  const fn = forwardPending.get(res.id)
  if (fn) { forwardPending.delete(res.id); fn(res.value) }
})

// "Open at Login" (Raycast ref 04 §3): config.json's openAtLogin becomes
// a real HKCU Run entry. Applied at launch (an edit made while the app
// was down still counts) and on every host-config-changed — the Settings
// view's ↵ and the renderer's config watch both land there. [D]
function applyOpenAtLogin() {
  var on = !!readConfig().openAtLogin
  var opts = { openAtLogin: on, path: process.execPath }
  // Dev run: electron.exe must be told which app directory to start. [D]
  if (!app.isPackaged) opts.args = [__dirname]
  try {
    app.setLoginItemSettings(opts)
    logLine("open at login: " + on)
  } catch (e) {
    logLine("open at login failed: " + e)
    return
  }
  if (!on) return
  // One mechanism only: older `oma-cast.ps1 install` runs left a
  // Startup-folder shortcut behind, and two entries racing at login ends
  // with the second instance toggling the window open on the desktop. [D]
  try {
    var legacy = path.join(process.env.APPDATA || "",
      "Microsoft", "Windows", "Start Menu", "Programs", "Startup", "oma-cast.lnk")
    if (fs.existsSync(legacy)) {
      fs.unlinkSync(legacy)
      logLine("removed legacy Startup shortcut: " + legacy)
    }
  } catch (e) { /* best effort */ }
}

function registerHotkey() {
  globalShortcut.unregisterAll()
  const key = String(readConfig().hotkey || "Alt+Space")
  try {
    if (globalShortcut.register(key, toggle)) { logLine("hotkey registered: " + key); return }
    logLine("hotkey could NOT be registered (taken by another app?): " + key)
    console.error("[oma-cast] could not register hotkey " + key)
  } catch (e) {
    logLine("hotkey failed: " + key + " " + e)
    console.error("[oma-cast] hotkey " + key + " failed: " + e)
  }
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
    logFileSetup()
    logLine("starting pid " + process.pid + " electron " + process.versions.electron)
    createWindow()
    registerHotkey()
    applyOpenAtLogin()
    focusHelperStart()
    pingFocusHelper()
    logLine("hotkey: " + String(readConfig().hotkey || "Alt+Space"))
    servePipe()
    if (process.argv.includes("--show")) show()
    else if (process.argv.includes("--toggle")) toggle()
  })
}

app.on("will-quit", function() {
  globalShortcut.unregisterAll()
  if (focusHelper) {
    try { focusHelper.kill() } catch (e) {}
    focusHelper = null
  }
})
app.on("window-all-closed", function() { /* stay resident for the hotkey */ })
