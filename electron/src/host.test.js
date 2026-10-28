const test = require("node:test")
const assert = require("node:assert/strict")
const childProcess = require("child_process")
const host = require("./host")

test("host.power: sleep invokes PowerShell SetSuspendState to force true sleep", async () => {
  const spawned = []
  const orig = childProcess.spawn
  childProcess.spawn = (bin, args, opts) => {
    spawned.push({ bin, args, opts })
    return { unref() {} }
  }
  try {
    host.power("sleep", 0)
    assert.equal(spawned.length, 0, "sleep is delayed past unmap")
    await new Promise(r => setTimeout(r, 450))
    assert.equal(spawned.length, 1)
    assert.equal(spawned[0].bin, "powershell.exe")
    assert.ok(spawned[0].args.includes("-Command"))
    assert.ok(spawned[0].args.some(a => a.includes("[System.Windows.Forms.Application]::SetSuspendState('Suspend', $false, $false)")))
    assert.equal(spawned[0].opts.windowsHide, true)
  } finally {
    childProcess.spawn = orig
  }
})

test("host.focusAppWindow: without a renderer bridge it answers false", async () => {
  // Plain node has no ipcRenderer: the send throws, settle(false) runs
  // once, and the 2.5 s safety timer is cleared — the launch fallback
  // still happens and the process can exit.
  const results = []
  host.focusAppWindow("Notion", taken => results.push(taken))
  await new Promise(r => setTimeout(r, 10))
  assert.deepEqual(results, [false])
})

test("host.power: shutdown and restart invoke shutdown.exe", () => {
  const spawned = []
  const orig = childProcess.spawn
  childProcess.spawn = (bin, args, opts) => {
    spawned.push({ bin, args, opts })
    return { unref() {} }
  }
  try {
    host.power("shutdown", 0)
    assert.equal(spawned.length, 1)
    assert.equal(spawned[0].bin, "shutdown.exe")
    assert.deepEqual(spawned[0].args, ["/s", "/t", "0", "/c", "oma-cast"])

    host.power("restart", 0)
    assert.equal(spawned.length, 2)
    assert.equal(spawned[1].bin, "shutdown.exe")
    assert.deepEqual(spawned[1].args, ["/r", "/t", "0", "/c", "oma-cast"])
  } finally {
    childProcess.spawn = orig
  }
})
