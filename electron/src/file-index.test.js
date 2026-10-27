// Everything-provider tests for src/file-index.js: es.exe discovery and
// the live query path, all behind injected fakes (no Everything, no spawn,
// no Windows — the assertions must hold on the Linux CI too). [D]
const test = require("node:test")
const assert = require("node:assert/strict")
const path = require("node:path")
const { createFileIndex, findEsExe } = require("./file-index")

// Expected paths go through path.join: on Windows the candidates carry
// backslashes, so forward-slash literals only ever passed on Linux. [D]
test("findEsExe checks both install dirs, then PATH", () => {
  const tried = []
  const install = path.join("C:/PF", "Everything", "es.exe")
  const onPath = path.join("C:/Tools", "es.exe")
  const found = findEsExe({
    env: (k) => (k === "ProgramFiles" || k === "ProgramFiles(x86)") ? "C:/PF" : "",
    existsSync: (p) => { tried.push(p); return p === onPath },
    runWhere: () => onPath + "\r\n"
  })
  assert.ok(tried.includes(install), "install dir probed: " + tried)
  assert.equal(found, onPath)
})

test("findEsExe prefers the install dir over PATH", () => {
  const install = path.join("C:/PF", "Everything", "es.exe")
  const found = findEsExe({
    env: (k) => (k === "ProgramFiles") ? "C:/PF" : "",
    existsSync: () => true,
    runWhere: () => { throw new Error("must not reach PATH") }
  })
  assert.equal(found, install)
})

test("findEsExe answers null with nothing anywhere", () => {
  const found = findEsExe({
    env: () => "",
    existsSync: () => false,
    runWhere: () => { throw new Error("not found") }
  })
  assert.equal(found, null)
})

test("searchEverything shapes es.exe lines like walk entries", () => {
  let got = null
  const idx = createFileIndex({
    provider: "everything",
    esExe: "C:/Tools/es.exe",
    execEs: (bin, args) => { got = { bin, args }; return "C:/Docs/report-q3.txt\r\nD:/notes.txt\r\n\r\n" }
  })
  const out = idx.searchEverything("report q3", 100)
  assert.deepEqual(got.args, ["-n", "100", "report q3"])
  assert.equal(got.bin, "C:/Tools/es.exe")
  assert.equal(out.length, 2)
  assert.equal(out[0].p, "C:/Docs/report-q3.txt")
  assert.equal(out[0].n, "report-q3.txt")
  assert.equal(out[0].nl, "report-q3.txt")
  assert.equal(out[0].pl, "c:/docs/report-q3.txt")
  assert.equal(out[1].n, "notes.txt")
})

test("searchEverything falls back to null when es fails", () => {
  const idx = createFileIndex({
    provider: "everything",
    esExe: "C:/Tools/es.exe",
    execEs: () => { throw new Error("Everything IPC failed") }
  })
  assert.equal(idx.searchEverything("report"), null)
  assert.equal(idx.searchEverything("  "), null)
})

test("the built-in provider never shells out", () => {
  let called = false
  const idx = createFileIndex({ execEs: () => { called = true; return "" } })
  assert.equal(idx.provider, "built-in")
  assert.equal(idx.searchEverything("report"), null)
  assert.equal(called, false)
})

test("setProvider flips modes and unknown values stay built-in", () => {
  const idx = createFileIndex({ esExe: "C:/Tools/es.exe", execEs: () => "" })
  idx.setProvider("everything")
  assert.equal(idx.provider, "everything")
  idx.setProvider("locator")
  assert.equal(idx.provider, "built-in")
})
