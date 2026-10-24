// Windows application library: Start Menu shortcuts stand in for Omarchy's
// shell.appLibrary. Enumerates .lnk files (user + machine scopes) through
// one PowerShell pass, extracts lazily cached PNG icons, launches through
// the shell. Async like DesktopEntries: `refresh()` repopulates and emits.
var fs = require("fs")
var path = require("path")
var crypto = require("crypto")
var childProcess = require("child_process")

var SCAN_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  "$shell = New-Object -ComObject WScript.Shell",
  "$dirs = @()",
  "if ($env:APPDATA) { $dirs += (Join-Path $env:APPDATA 'Microsoft\\Windows\\Start Menu\\Programs') }",
  "if ($env:ProgramData) { $dirs += (Join-Path $env:ProgramData 'Microsoft\\Windows\\Start Menu\\Programs') }",
  "$out = @()",
  "foreach ($d in $dirs) {",
  "  if (-not (Test-Path -LiteralPath $d)) { continue }",
  "  Get-ChildItem -LiteralPath $d -Recurse -Filter '*.lnk' -File | ForEach-Object {",
  "    try { $s = $shell.CreateShortcut($_.FullName) } catch { return }",
  "    $out += [PSCustomObject]@{ name = $_.BaseName; link = $_.FullName; target = $s.TargetPath }",
  "  }",
  "}",
  "$out | ConvertTo-Json -Compress"
].join("\n")

// Icon extraction: 32px associated icon → PNG in the icon cache.
var ICON_SCRIPT = [
  "param([string]$Source, [string]$Out)",
  "Add-Type -AssemblyName System.Drawing",
  "$src = $Source",
  "if (-not (Test-Path -LiteralPath $src)) { exit 1 }",
  "$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($src)",
  "if (-not $icon) { exit 1 }",
  "$bmp = $icon.ToBitmap()",
  "$bmp.Save($Out, [System.Drawing.Imaging.ImageFormat]::Png)",
  "$bmp.Dispose(); $icon.Dispose()"
].join("\n")

function createApps(opts) {
  opts = opts || {}
  var apps = {
    entries: [],
    loading: false,
    iconDir: opts.iconDir || "",
    _listeners: { changed: [] },
    _icons: {}
  }
  apps.on = function(event, cb) { apps._listeners[event].push(cb) }
  function emit() { (apps._listeners.changed || []).forEach(function(cb) { cb() }) }

  function runPowerShell(script, args, timeoutMs) {
    return new Promise(function(resolve) {
      childProcess.execFile("powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script].concat(args || []),
        { timeout: timeoutMs || 30000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
        function(err, stdout) { resolve({ error: err, stdout: String(stdout || "") }) })
    })
  }

  // One enumeration pass; user-scope links win over machine-scope on name
  // collisions (Windows resolves the same way for Start Menu entries).
  apps.refresh = function() {
    if (apps.loading) return Promise.resolve(apps.entries)
    apps.loading = true
    return runPowerShell(SCAN_SCRIPT).then(function(res) {
      apps.loading = false
      var parsed = []
      try { parsed = JSON.parse(res.stdout) || [] } catch (e) { parsed = [] }
      if (!Array.isArray(parsed)) parsed = [parsed]
      var seen = {}
      var out = []
      // Later entries are machine-scope (script order: user first); keep the
      // first occurrence of each name, drop empty links and invalid paths.
      for (var i = 0; i < parsed.length; i++) {
        var row = parsed[i]
        if (!row || !row.name || !row.link) continue
        var key = String(row.name).toLowerCase()
        if (seen[key]) continue
        seen[key] = true
        out.push({
          id: String(row.link),
          name: String(row.name),
          // The icon slot is the .lnk path itself: apps.iconSource extracts
          // and caches its associated icon lazily. [D]
          icon: String(row.link),
          target: String(row.target || ""),
          link: String(row.link),
          genericName: "",
          keywords: [],
          noDisplay: false
        })
      }
      out.sort(function(a, b) { return a.name.localeCompare(b.name, undefined, { sensitivity: "base" }) })
      apps.entries = out
      emit()
      return out
    }, function() { apps.loading = false; return apps.entries })
  }

  // Lazy icon extraction, cached under iconDir. Resolves to a file:// URL
  // or "" (rows without icons just show the glyph slot empty). [D]
  apps.iconSource = function(linkPath) {
    if (!linkPath) return Promise.resolve("")
    if (apps._icons[linkPath] !== undefined) return Promise.resolve(apps._icons[linkPath])
    if (!apps.iconDir) return Promise.resolve("")
    var hash = crypto.createHash("sha1").update(String(linkPath)).digest("hex").slice(0, 16)
    var png = path.join(apps.iconDir, hash + ".png")
    if (fs.existsSync(png)) {
      apps._icons[linkPath] = "file:///" + png.replace(/\\/g, "/")
      return Promise.resolve(apps._icons[linkPath])
    }
    return new Promise(function(resolve) {
      var script = "$src = $args[0]; $out = $args[1]; " +
        "Add-Type -AssemblyName System.Drawing; " +
        "if (-not (Test-Path -LiteralPath $src)) { exit 1 }; " +
        "$icon = [System.Drawing.Icon]::ExtractAssociatedIcon($src); " +
        "if (-not $icon) { exit 1 }; " +
        "$bmp = $icon.ToBitmap(); $bmp.Save($out, [System.Drawing.Imaging.ImageFormat]::Png); " +
        "$bmp.Dispose(); $icon.Dispose()"
      try { fs.mkdirSync(apps.iconDir, { recursive: true }) } catch (e) {}
      childProcess.execFile("powershell.exe",
        ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script, linkPath, png],
        { timeout: 15000, windowsHide: true },
        function(err) {
          var url = (!err && fs.existsSync(png)) ? "file:///" + png.replace(/\\/g, "/") : ""
          apps._icons[linkPath] = url
          resolve(url)
        })
    })
  }

  // Launch through the shell (ShellExecute on the .lnk): UAC-aware, runs
  // the shortcut's target with its arguments and working directory.
  apps.launch = function(linkPath) {
    return new Promise(function(resolve) {
      childProcess.execFile("explorer.exe", [String(linkPath)], { windowsHide: true }, function(err) {
        resolve(err ? String(err.message || err) : "")
      })
    })
  }

  return apps
}

if (typeof module !== "undefined") {
  module.exports = { createApps: createApps, SCAN_SCRIPT: SCAN_SCRIPT }
}
