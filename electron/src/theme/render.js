// Port of Omarchy's `bin/omarchy-theme-set-templates` (omacom/omarchy,
// MIT): renders default/themed/shell.toml.tpl against a theme's colors.toml.
// Value tokens ({{ key }}, {{ key_strip }}, {{ key_rgb }}), mix functions
// with awk-compatible rounding, and the gradient functions that feed
// Border.surfaceSpec. Pure JS: text in, text out.
var color = require("./color")

var MIX_TOKEN = /\{\{\s*(mix(?:_strip|_rgb)?)\s+([A-Za-z0-9_]+)\s+([A-Za-z0-9_]+)\s+([0-9]+(?:\.[0-9]+)?%?)\s*\}\}/g
var GRADIENT_TOKEN = /\{\{\s*(hypr_gradient|gradient_start|shell_gradient)\s+([^}]+?)\s*\}\}/g

function hexToRgbPair(hex) {
  var h = String(hex).replace(/^#/, "")
  return [parseInt(h.substr(0, 2), 16), parseInt(h.substr(2, 2), 16), parseInt(h.substr(4, 2), 16)]
}

// resolve_theme_ref: theme color if the key exists, else the fallback's
// theme color, else the fallback verbatim, else the key itself.
function resolveThemeRef(colors, key, fallback) {
  if (colors[key]) return colors[key]
  if (fallback && colors[fallback]) return colors[fallback]
  if (fallback) return fallback
  return key
}

// parse_gradient: split a spec into colors (theme keys resolved to hex) and
// an optional angle; a non-gradient spec yields one color.
function parseGradient(colors, spec) {
  var parts = String(spec || "").trim().split(/\s+/)
  var out = { colors: [], angle: "" }
  for (var i = 0; i < parts.length; i++) {
    var part = parts[i]
    if (!part) continue
    if (/^-?[0-9]+(\.[0-9]+)?deg$/.test(part)) out.angle = part.replace(/deg$/, "")
    else {
      var c = part
      var trimmed = part.replace(/^\s+|\s+$/g, "")
      if (colors[trimmed]) c = colors[trimmed]
      out.colors.push(c)
    }
  }
  return out
}

// shell_gradient: colors joined by spaces plus " <angle>deg", or the raw
// spec when it isn't a gradient.
function shellGradient(colors, key, fallback) {
  var g = parseGradient(colors, resolveThemeRef(colors, key, fallback))
  if (g.colors.length === 0) return resolveThemeRef(colors, key, fallback)
  var value = g.colors.join(" ")
  if (g.angle) value += " " + g.angle + "deg"
  return value
}

// gradient_start: first color as #rrggbb.
function gradientStart(colors, key, fallback) {
  var g = parseGradient(colors, resolveThemeRef(colors, key, fallback))
  var c = g.colors.length > 0 ? g.colors[0] : resolveThemeRef(colors, key, fallback)
  return colorToHex(c)
}

// hypr_gradient: Hyprland's `{ colors = { "a","b" }, angle = N }` table form.
function hyprGradient(colors, key, fallback) {
  var g = parseGradient(colors, resolveThemeRef(colors, key, fallback))
  if (g.colors.length === 0) return '"' + resolveThemeRef(colors, key, fallback) + '"'
  if (g.colors.length === 1) return '"' + g.colors[0] + '"'
  var value = '{ colors = {'
  for (var i = 0; i < g.colors.length; i++) value += (i > 0 ? "," : "") + ' "' + g.colors[i] + '"'
  value += " }"
  if (g.angle) value += ", angle = " + g.angle
  return value + " }"
}

// color_to_shell_hex: normalize hex, rgba(), rgb() and 0x forms to #rrggbb.
function colorToHex(value) {
  var v = String(value || "").trim()
  var m
  if (/^#[0-9A-Fa-f]{6}([0-9A-Fa-f]{2})?$/.test(v)) return "#" + v.slice(1, 7)
  if ((m = v.match(/^rgba?\(([0-9A-Fa-f]{6})([0-9A-Fa-f]{2})?\)$/i))) return "#" + m[1]
  if ((m = v.match(/^rgba?\(([0-9]+),([0-9]+),([0-9]+)(,[0-9.]+)?\)$/i))) {
    var r = Math.min(255, Number(m[1])), g = Math.min(255, Number(m[2])), b = Math.min(255, Number(m[3]))
    function h(n) { var s = n.toString(16); return s.length < 2 ? "0" + s : s }
    return "#" + h(r) + h(g) + h(b)
  }
  if (/^0x[0-9A-Fa-f]{8}$/.test(v)) return "#" + v.slice(4, 10)
  return v
}

// The value/mix tables the awk pass builds, then a single substitution pass.
function buildTables(templateText, colors) {
  var values = {}
  for (var key in colors) {
    var value = colors[key]
    values["{{ " + key + " }}"] = value
    values["{{ " + key + "_strip }}"] = String(value).replace(/^#/, "")
    if (/^#[0-9A-Fa-f]{6}$/.test(value)) values["{{ " + key + "_rgb }}"] = hexToRgbPair(value).join(",")
  }

  var seen = {}
  function scan(re, fn) {
    re.lastIndex = 0
    var m
    while ((m = re.exec(templateText)) !== null) fn(m)
  }
  scan(MIX_TOKEN, function(m) {
    if (seen[m[0]]) return
    seen[m[0]] = 1
    var start = colors[m[2]], end = colors[m[3]]
    if (!/^#[0-9A-Fa-f]{6}$/.test(start || "") || !/^#[0-9A-Fa-f]{6}$/.test(end || "")) return
    var mixed = color.mixColor(start, end, m[4])
    var out = mixed
    if (m[1] === "mix_strip") out = mixed.slice(1)
    else if (m[1] === "mix_rgb") out = hexToRgbPair(mixed).join(",")
    values[m[0]] = out
  })
  scan(GRADIENT_TOKEN, function(m) {
    if (seen[m[0]]) return
    seen[m[0]] = 1
    var fn = m[1], rest = m[2]
    var sp = rest.split(/\s+/)
    var k = sp[0], fallback = sp.slice(1).join(" ")
    if (fn === "shell_gradient") values[m[0]] = shellGradient(colors, k, fallback)
    else if (fn === "gradient_start") values[m[0]] = gradientStart(colors, k, fallback)
    else values[m[0]] = hyprGradient(colors, k, fallback)
  })
  return values
}

// render: the awk render() scan — unknown tokens print verbatim and the
// scan resumes after the opening brace.
function render(templateText, colors) {
  var values = buildTables(templateText, colors)
  var line = String(templateText)
  var out = ""
  while (true) {
    var open = line.indexOf("{{")
    if (open < 0) break
    var span = line.indexOf("}}", open + 2)
    if (span < 0) break
    var token = line.slice(open, span + 2)
    if (Object.prototype.hasOwnProperty.call(values, token)) {
      out += line.slice(0, open) + values[token]
      line = line.slice(open + token.length)
    } else {
      out += line.slice(0, open + 1)
      line = line.slice(open + 1)
    }
  }
  return out + line
}

// One call: colors.toml text + template text → rendered shell.toml text.
function renderShell(colorsRaw, templateText, hasLightMode) {
  var colors = color.resolve(colorsRaw, hasLightMode)
  return render(templateText, colors)
}

if (typeof module !== "undefined") {
  module.exports = { render: render, renderShell: renderShell, mixColor: color.mixColor, colorToHex: colorToHex }
}
