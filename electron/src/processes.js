// Running-process listing and termination for the Kill Process view
// (SPEC Phase 8 first-party extras). PowerShell for the snapshot,
// taskkill /F for the kill; the launcher's own processes are excluded so
// it cannot commit suicide from its own list — our pid, plus anything
// running from our own exe (main, GPU and renderer processes all share
// the path). [D]
var childProcess = require("child_process")

// name + pid + working set, biggest consumers first.
const LIST_SCRIPT = [
  "$ErrorActionPreference = 'SilentlyContinue'",
  // Node decodes stdout as UTF-8; without this a non-ASCII process name
  // arrives in the OEM codepage. Best effort: a failure here must not
  // cost the whole list.
  "try { [Console]::OutputEncoding = [System.Text.Encoding]::UTF8 } catch {}",
  "$out = Get-Process | Where-Object { $_.Id -ne 0 -and $_.Id -ne 4 } | ForEach-Object {",
  "  [PSCustomObject]@{ pid = $_.Id; name = $_.ProcessName; ws = [int64]($_.WorkingSet64); path = $(try { $_.Path } catch { '' }) }",
  "}",
  "($out | Sort-Object ws -Descending | Select-Object -First 300) | ConvertTo-Json -Compress"
].join("; ")

  function runPowerShell(execFile, script, timeoutMs) {
    return new Promise(function(resolve) {
      execFile("powershell.exe",
      ["-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", script],
      { timeout: timeoutMs || 10000, maxBuffer: 8 * 1024 * 1024, windowsHide: true },
      function(err, stdout) { resolve({ error: err, stdout: String(stdout || "") }) })
  })
}

function createProcesses(opts) {
  opts = opts || {}
  var execFile = opts.execFile || childProcess.execFile
  var execFileSync = opts.execFileSync || childProcess.execFileSync
  var state = { rows: [], at: 0, loading: false }
  var listeners = { changed: [] }
  var own = opts.ownPid || process.pid
  // Path comparison: the snapshot gives Windows paths, callers may not.
  function norm(p) { return String(p || "").replace(/\//g, "\\").toLowerCase() }
  var excludePaths = (opts.excludePaths || []).map(norm)

  function emit() { (listeners.changed || []).forEach(function(cb) { cb() }) }

  return {
    get rows() { return state.rows },
    get loading() { return state.loading },
    get at() { return state.at },

    refresh: function(force) {
      if (state.loading) return Promise.resolve(state.rows)
      // A fresh snapshot is only worth re-taking every couple of seconds
      // (the view rebuilds after kills, pushes and searches).
      if (!force && state.rows.length && Date.now() - state.at < 2000) return Promise.resolve(state.rows)
      state.loading = true
      emit()
      return runPowerShell(execFile, LIST_SCRIPT).then(function(res) {
        state.loading = false
        var parsed = []
        try { parsed = JSON.parse(res.stdout) || [] } catch (e) { parsed = [] }
        if (!Array.isArray(parsed)) parsed = [parsed]
        state.rows = parsed
          .filter(function(r) {
            if (!r || Number(r.pid) <= 0 || Number(r.pid) === own || !r.name) return false
            return excludePaths.indexOf(norm(r.path)) < 0
          })
          .map(function(r) {
            return { pid: Number(r.pid), name: String(r.name), ws: Number(r.ws) || 0, path: String(r.path || "") }
          })
          .sort(function(a, b) { return b.ws - a.ws })
        state.at = Date.now()
        emit()
        return state.rows
      }, function() {
        state.loading = false
        emit()
        return state.rows
      })
    },

    // taskkill /F is the OS-level kill; a refused pid (protected process)
    // comes back as a non-zero exit with a message. Synchronous on
    // purpose: the backend's RPC world wants the outcome now. [D]
    kill: function(pid) {
      try {
        execFileSync("taskkill.exe", ["/PID", String(pid), "/F"], { timeout: 8000, windowsHide: true, stdio: "ignore" })
        return { ok: true, message: "" }
      } catch (e) {
        var text = String((e && e.stdout) || "").trim() || String((e && e.message) || "").trim()
        return { ok: false, message: text }
      }
    },

    // Optimistic removal so the view rebuild right after a kill doesn't
    // flash the dead row again; refresh(true) refills from the OS.
    remove: function(pid) {
      state.rows = state.rows.filter(function(r) { return r.pid !== Number(pid) })
      emit()
    },

    on: function(event, cb) { if (listeners[event]) listeners[event].push(cb) }
  }
}

if (typeof module !== "undefined") {
  module.exports = { createProcesses: createProcesses, LIST_SCRIPT: LIST_SCRIPT }
}
