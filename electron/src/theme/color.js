// Port of Omarchy's `bin/omarchy-theme-color` (omacom/omarchy, MIT).
// Shared colors.toml parser/resolver: alias/fallback cascade, derived
// shades, and mode detection, so palette resolution matches the shell
// exactly. Pure JS, no I/O beyond the text handed in.

// Mix two hex colors. Amount may be a fraction (0.30) or percentage (30%).
// Rounds like awk's int(x + 0.5) so no generated color drifts from Omarchy.
function mixColor(start, end, amount) {
  var s = String(start).replace(/^#/, "")
  var e = String(end).replace(/^#/, "")
  var a = String(amount)
  if (/%$/.test(a)) a = Number(a.replace(/%$/, "")) / 100
  else { a = Number(a); if (a > 1) a = a / 100 }
  if (!(a >= 0)) a = 0
  if (a > 1) a = 1
  function pair(hex, i) { return parseInt(hex.substr(i, 2), 16) }
  function mix1(x, y) { return Math.trunc(x * (1 - a) + y * a + 0.5) }
  function hex2(n) { return (n < 16 ? "0" : "") + n.toString(16) }
  return "#" + hex2(mix1(pair(s, 0), pair(e, 0))) + hex2(mix1(pair(s, 2), pair(e, 2))) + hex2(mix1(pair(s, 4), pair(e, 4)))
}

// Parse raw key=value pairs out of colors.toml. Quoted values keep the text
// between quotes (inline comments ignored); unquoted values are trimmed.
function parseColors(raw) {
  var out = {}
  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i]
    var eq = line.indexOf("=")
    if (eq < 0) continue
    var key = line.slice(0, eq).replace(/["' ]/g, "")
    if (!key || key.charAt(0) === "#") continue
    var value = line.slice(eq + 1)
    if (value.indexOf('"') >= 0 || value.indexOf("'") >= 0) {
      var q = value.search(/["']/)
      value = value.slice(q + 1)
      value = value.slice(0, value.search(/["']/) < 0 ? value.length : value.search(/["']/))
    } else {
      value = value.replace(/^\s+|\s+$/g, "")
    }
    if (!/^[A-Za-z0-9_-]+$/.test(key)) continue
    if (!/^[A-Za-z0-9#(),._+/%\ -]*$/.test(value)) continue
    out[key] = value
  }
  return out
}

var LEGACY_PALIAS = {
  background: "bg", dark_background: "dark_bg", darker_background: "darker_bg",
  lighter_background: "lighter_bg", foreground: "fg", dark_foreground: "dark_fg",
  light_foreground: "light_fg", bright_foreground: "bright_fg"
}
var LEGACY_ALIAS = {
  red: "color1", green: "color2", yellow: "color3", blue: "color4",
  magenta: "color5", cyan: "color6", bright_red: "color9",
  bright_green: "color10", bright_yellow: "color11", bright_blue: "color12",
  bright_magenta: "color13", bright_cyan: "color14"
}
var ANSI_ALIAS = {
  color0: "background", color1: "red", color2: "green", color3: "yellow",
  color4: "blue", color5: "magenta", color6: "cyan", color7: "foreground",
  color8: "muted", color9: "bright_red", color10: "bright_green",
  color11: "bright_yellow", color12: "bright_blue", color13: "bright_magenta",
  color14: "bright_cyan", color15: "bright_foreground"
}

// Resolve every alias/derived key the bash resolver does. Returns the flat
// dict `omarchy-theme-color --all` prints (minus the sort).
function resolve(raw, hasLightModeFile) {
  var c = parseColors(raw)

  function alias(key, from) { if (!c[key] && c[from]) c[key] = c[from] }
  function aliasIf(key, from) { if (!c[key]) c[key] = c[from] }

  for (var k in LEGACY_PALIAS) alias(k, LEGACY_PALIAS[k])

  if (!c.background) c.background = c.color0
  if (!c.foreground) c.foreground = c.color7
  if (c.background) c.color0 = c.background
  if (c.foreground) c.color7 = c.foreground

  for (k in LEGACY_ALIAS) alias(k, LEGACY_ALIAS[k])
  alias("magenta", "purple")
  alias("bright_magenta", "bright_purple")

  if (!c.light_foreground) c.light_foreground = c.color7 !== undefined ? c.color7 : c.foreground
  if (!c.bright_foreground) c.bright_foreground = c.color15 !== undefined ? c.color15 : c.foreground
  c.cursor = c.bright_foreground
  if (!c.lighter_background) c.lighter_background = c.color0 !== undefined ? c.color0 : c.background
  if (!c.dark_foreground) c.dark_foreground = c.color8 !== undefined ? c.color8 : c.foreground
  if (!c.muted) c.muted = c.color8 !== undefined ? c.color8 : c.dark_foreground
  if (!c.selection) c.selection = c.selection_background !== undefined ? c.selection_background
    : (c.color8 !== undefined ? c.color8 : (c.color0 !== undefined ? c.color0 : c.background))
  if (!c.selection_background) c.selection_background = c.selection
  if (!c.selection_foreground) c.selection_foreground = c.bright_foreground
  if (!c.orange) c.orange = c.yellow
  if (!c.brown) c.brown = mixColor(c.orange, "#000000", "50%")

  if (!c.dark_background) c.dark_background = mixColor(c.background, "#000000", "25%")
  if (!c.darker_background) c.darker_background = mixColor(c.background, "#000000", "50%")
  if (!c.bright_red) c.bright_red = mixColor(c.red, "#ffffff", "20%")
  if (!c.bright_yellow) c.bright_yellow = mixColor(c.yellow, "#ffffff", "20%")
  if (!c.bright_green) c.bright_green = mixColor(c.green, "#ffffff", "20%")
  if (!c.bright_cyan) c.bright_cyan = mixColor(c.cyan, "#ffffff", "20%")
  if (!c.bright_blue) c.bright_blue = mixColor(c.blue, "#ffffff", "20%")
  if (!c.bright_magenta) c.bright_magenta = mixColor(c.magenta, "#ffffff", "20%")
  aliasIf("purple", "magenta")
  aliasIf("bright_purple", "bright_magenta")

  for (k in ANSI_ALIAS) alias(k, ANSI_ALIAS[k])
  for (k in LEGACY_PALIAS) if (c[k]) c[LEGACY_PALIAS[k]] = c[k]

  // Mode precedence: mode, legacy theme_type, light.mode file, luminance.
  if (!c.mode) c.mode = c.theme_type
  if (!c.mode) {
    if (hasLightModeFile) c.mode = "light"
    else if (/^#[0-9A-Fa-f]{6}$/.test(c.background || "")) {
      var bg = c.background.slice(1)
      var lum = parseInt(bg.substr(0, 2), 16) + parseInt(bg.substr(2, 2), 16) + parseInt(bg.substr(4, 2), 16)
      c.mode = lum > 382 ? "light" : "dark"
    } else c.mode = "dark"
  }
  c.theme_type = c.mode
  return c
}

if (typeof module !== "undefined") {
  module.exports = { mixColor: mixColor, parseColors: parseColors, resolve: resolve }
}
