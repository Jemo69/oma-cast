// File search matching (SPEC §8.6 "name match first, then path, sorted by
// recency"). Pure: entries are {p: path, n: name, d: isDir, m: mtimeMs}.
// The walker that produces them lives in electron/src/file-index.js; this
// module only ranks and shapes them, so both platforms can share it. [D]

// SPEC default excludes; AppData added for Windows (huge, low value) [D].
var DEFAULT_EXCLUDE_DIRS = ["node_modules", ".git", ".cache", "CACHEDIR.TAG", ".jj", "AppData"]

function isHidden(name) {
  var n = String(name || "")
  return n.charAt(0) === "." || n.charAt(0) === "$"   // dotfiles + Windows hidden/系统 prefixes
}

// Case-insensitive subsequence: every char of `needle` appears in `hay`
// in order. Returns 0 for no match, otherwise a quality score in (0, 1]
// that rewards contiguous and early matches. Cheap enough for 100k rows.
function subsequence(needle, hay) {
  if (!needle) return 1
  var i = 0, qi = 0, score = 0, streak = 0, first = -1
  var n = needle.toLowerCase(), h = String(hay || "").toLowerCase()
  if (n.length > h.length) return 0
  for (; qi < n.length; qi++) {
    var ch = n.charAt(qi)
    var at = h.indexOf(ch, i)
    if (at < 0) return 0
    if (first < 0) first = at
    streak = (at === i && i > 0) ? streak + 1 : 0
    score += 1 + streak * 0.5 - Math.min(at - i, 10) * 0.02
    i = at + 1
  }
  // Whole-query position bonus: matches near the start rank higher.
  score += Math.max(0, 8 - first) * 0.1
  return score / (n.length + 2)
}

// Quality of one token against a single string: exact > prefix > word >
// substring > subsequence.
function tokenScore(token, text) {
  var t = String(token || "").toLowerCase()
  var s = String(text || "").toLowerCase()
  if (!t) return 1
  if (s === t) return 100
  if (s.indexOf(t) === 0) return 80
  if (s.indexOf(t) > 0) {
    var before = s.charAt(s.indexOf(t) - 1)
    if (before === " " || before === "-" || before === "_" || before === "." || before === "/") return 70
    return 60
  }
  var sub = subsequence(t, s)
  return sub > 0 ? 30 + sub * 20 : 0
}

// Order per SPEC: all-token name matches first, then name+path mixes, then
// path-only; within a tier by quality, then recency (mtime), then name.
// Returns the top `limit` matches: [{entry, tier, quality}].
function match(entries, query, opts) {
  opts = opts || {}
  var limit = opts.limit || 30
  var tokens = String(query || "").trim().toLowerCase().split(/\s+/).filter(Boolean)
  if (tokens.length === 0 || !entries || entries.length === 0) return []
  var minQuality = opts.minQuality || 0
  var out = []
  for (var e = 0; e < entries.length; e++) {
    var entry = entries[e]
    var quality = 0
    var allInName = true
    var ok = true
    for (var t = 0; t < tokens.length; t++) {
      var nameScore = tokenScore(tokens[t], entry.n)
      if (nameScore > 0) { quality += nameScore; continue }
      allInName = false
      var pathScore = tokenScore(tokens[t], entry.p)
      if (pathScore > 0) { quality += pathScore * 0.5; continue }
      ok = false
      break
    }
    if (!ok || quality < minQuality) continue
    var tier = allInName ? 0 : (tokens.length > 1 ? 1 : 2)
    out.push({ entry: entry, tier: tier, quality: quality })
  }
  out.sort(function(a, b) {
    if (a.tier !== b.tier) return a.tier - b.tier
    if (a.quality !== b.quality) return b.quality - a.quality
    var am = Number(a.entry.m) || 0
    var bm = Number(b.entry.m) || 0
    if (am !== bm) return bm - am
    return String(a.entry.n).length - String(b.entry.n).length
  })
  return out.slice(0, limit)
}

// The row shape ResultRow renders (glyph in the bundled Nerd Font).
function candidate(entry) {
  var dir = !!entry.d
  return {
    id: "file:" + entry.p,
    type: "file",
    kind: "file",
    title: entry.n,
    subtitle: parentOf(entry.p),
    typeLabel: dir ? "Folder" : "File",
    glyph: dir ? "" : "",   // nf-fa-folder / nf-fa-file
    glyphFont: "",
    path: entry.p,
    isDir: dir,
    rootSearch: { when: "searching" }
  }
}

function parentOf(p) {
  var s = String(p || "").replace(/[\\/]+$/, "")
  var at = Math.max(s.lastIndexOf("/"), s.lastIndexOf("\\"))
  return at > 0 ? s.slice(0, at) : s
}

// File rows: Open / Reveal in Explorer / Copy Path (ref 04 §1 "Open,
// Reveal, Copy Path"). No favorites or aliases — those settings would
// outlive the file. [D]
function actionsForFile(candidateRow) {
  return [
    { id: "open", title: "Open", shortcut: "↵", section: "primary", icon: "\uf08e" },
    { id: "reveal", title: "Reveal in Explorer", shortcut: "Ctrl ↵", section: "primary", icon: "\uf06e" },
    { id: "copy-path", title: "Copy Path", shortcut: "Ctrl Shift C", section: "copy", icon: "\uf0c5" }
  ]
}

if (typeof module !== "undefined") {
  module.exports = {
    DEFAULT_EXCLUDE_DIRS: DEFAULT_EXCLUDE_DIRS,
    isHidden: isHidden,
    subsequence: subsequence,
    tokenScore: tokenScore,
    match: match,
    candidate: candidate,
    parentOf: parentOf,
    actionsForFile: actionsForFile
  }
}
