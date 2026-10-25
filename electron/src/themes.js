// Theme discovery and resolution — Omarchy's `omarchy theme set` shape: a
// theme is a directory holding `colors.toml`. Two roots, the bundled one
// first:
//
//   themes/<name>/colors.toml                   shipped with the app
//   %APPDATA%\oma-cast\themes\<name>\colors.toml the user's place for themes
//
// The shell template is bundled (`themes/shell.toml.tpl`, rendered with
// the same port of `omarchy-theme-set-templates` the tests golden); a
// theme may override it with its own `shell.toml`. `resolve()` returns the
// rendered template text, ready for surface.createTheme. A missing or
// unreadable theme falls back to the bundled default instead of a blank
// window. [D]
var fs = require("fs")
var path = require("path")
var render = require("./theme/render")

var DEFAULT_THEME = "tokyo-night"
var TEMPLATE_NAME = "shell.toml.tpl"

function roots(opts) {
  opts = opts || {}
  return [
    { dir: opts.bundledDir || "", source: "bundled" },
    { dir: opts.userDir || "", source: "user" }
  ]
}

// Every theme found, a name once (the bundled copy wins), sorted.
function listThemes(opts) {
  var out = []
  var seen = {}
  roots(opts).forEach(function(root) {
    if (!root.dir) return
    var names = []
    try { names = fs.readdirSync(root.dir) } catch (e) { return }
    names.sort().forEach(function(name) {
      if (seen[name]) return
      var dir = path.join(root.dir, name)
      try { if (!fs.statSync(dir).isDirectory()) return } catch (e) { return }
      if (!fs.existsSync(path.join(dir, "colors.toml"))) return
      seen[name] = true
      out.push({ name: name, dir: dir, source: root.source })
    })
  })
  return out
}

function find(name, opts) {
  var wanted = String(name || "").trim() || DEFAULT_THEME
  var all = listThemes(opts)
  for (var i = 0; i < all.length; i++) if (all[i].name === wanted) return all[i]
  for (var j = 0; j < all.length; j++) if (all[j].name === DEFAULT_THEME) return all[j]
  return all[0] || null
}

// { name, source, colorsRaw, shellRaw } — shellRaw is the template already
// rendered against the colors, the input surface.createTheme wants.
function resolve(name, opts) {
  opts = opts || {}
  var theme = find(name, opts)
  if (!theme) return { name: "", source: "", colorsRaw: "", shellRaw: "" }

  var colorsRaw = ""
  try { colorsRaw = fs.readFileSync(path.join(theme.dir, "colors.toml"), "utf8") } catch (e) {}

  // Theme's own template, else the bundled one.
  var templateRaw = ""
  try { templateRaw = fs.readFileSync(path.join(theme.dir, "shell.toml"), "utf8") } catch (e) {}
  if (!templateRaw && opts.bundledDir) {
    try { templateRaw = fs.readFileSync(path.join(opts.bundledDir, TEMPLATE_NAME), "utf8") } catch (e) {}
  }

  var shellRaw = ""
  try { shellRaw = render.renderShell(colorsRaw, templateRaw, false) } catch (e) {}
  return { name: theme.name, source: theme.source, colorsRaw: colorsRaw, shellRaw: shellRaw }
}

if (typeof module !== "undefined") {
  module.exports = { DEFAULT_THEME: DEFAULT_THEME, listThemes: listThemes, find: find, resolve: resolve }
}
