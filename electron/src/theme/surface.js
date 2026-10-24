// Runtime port of Omarchy's Commons singletons the launcher UI binds to:
// Color.qml (palette + shell.toml surfaces), Style.qml (spacing, typography,
// corner/gap tokens) and Border.qml's surfaceSpec path. Values resolve
// exactly as the shell resolves them on Omarchy, so the Windows UI paints
// the same pixels. [O] semantics, MIT (omacom/omarchy).

// ---- Util.qml (the pieces the UI needs) --------------------------------
function clamp(v, min, max) { var n = Number(v); if (!isFinite(n)) return min; return Math.max(min, Math.min(max, n)) }
function clampAlpha(v) { return clamp(v, 0, 1) }
// Util.alpha: base color + opacity → CSS rgba() string.
function alpha(c, opacity) {
  var a = clampAlpha(opacity)
  if (c === null || c === undefined || c === "" ) return "rgba(0,0,0," + a + ")"
  var rgb = parseColor(c)
  if (!rgb) return "rgba(0,0,0," + a + ")"
  return "rgba(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + "," + a + ")"
}
function parseColor(c) {
  var s = String(c).replace(/^\s+|\s+$/g, "")
  var m = s.match(/^#([0-9A-Fa-f]{3})$/)
  if (m) return [parseInt(m[1][0] + m[1][0], 16), parseInt(m[1][1] + m[1][1], 16), parseInt(m[1][2] + m[1][2], 16)]
  m = s.match(/^#([0-9A-Fa-f]{6})([0-9A-Fa-f]{2})?$/)
  if (m) return [parseInt(m[1].substr(0, 2), 16), parseInt(m[1].substr(2, 2), 16), parseInt(m[1].substr(4, 2), 16)]
  return null
}

// ---- BorderGeometry.js -------------------------------------------------
function parseWidthSpec(value, fallback) {
  var fb = Number(fallback)
  if (!isFinite(fb) || fb < 0) fb = 0
  if (value === undefined || value === null || value === "") return { top: fb, right: fb, bottom: fb, left: fb }
  var parts = String(value).match(/-?\d+(?:\.\d+)?/g) || []
  var nums = []
  for (var i = 0; i < parts.length && i < 4; i++) {
    var n = Number(parts[i])
    nums.push(isFinite(n) && n > 0 ? n : 0)
  }
  if (nums.length === 0) nums = [fb]
  if (nums.length === 1) return { top: nums[0], right: nums[0], bottom: nums[0], left: nums[0] }
  if (nums.length === 2) return { top: nums[0], right: nums[1], bottom: nums[0], left: nums[1] }
  if (nums.length === 3) return { top: nums[0], right: nums[1], bottom: nums[2], left: nums[1] }
  return { top: nums[0], right: nums[1], bottom: nums[2], left: nums[3] }
}
function withSideOverrides(widths, top, right, bottom, left) {
  var out = { top: Number(widths && widths.top) || 0, right: Number(widths && widths.right) || 0,
    bottom: Number(widths && widths.bottom) || 0, left: Number(widths && widths.left) || 0 }
  if (top !== undefined && top !== null && top !== "") out.top = Math.max(0, Number(top) || 0)
  if (right !== undefined && right !== null && right !== "") out.right = Math.max(0, Number(right) || 0)
  if (bottom !== undefined && bottom !== null && bottom !== "") out.bottom = Math.max(0, Number(bottom) || 0)
  if (left !== undefined && left !== null && left !== "") out.left = Math.max(0, Number(left) || 0)
  return out
}
function maxWidth(widths) {
  if (!widths) return 0
  return Math.max(widths.top || 0, widths.right || 0, widths.bottom || 0, widths.left || 0)
}
function isUniform(w) {
  var t = w.top || 0
  return t === (w.right || 0) && t === (w.bottom || 0) && t === (w.left || 0)
}
function needsOverlay(spec) {
  if (!spec || maxWidth(spec.widths) <= 0) return false
  return !!(spec.gradient && spec.gradient.enabled) || !isUniform(spec.widths)
}
function canUseNative(spec) { return !!spec && maxWidth(spec.widths) > 0 && !needsOverlay(spec) }

// ---- Color.qml ---------------------------------------------------------
var FOUNDATION = { foreground: "#cacccc", background: "#101315", accent: "#cacccc", urgent: "#a55555", muted: "#707880" }

function loadColors(raw) {
  // Same key walk as Color.loadColors.
  var out = Object.assign({}, FOUNDATION)
  var foundAccent = false, foundMuted = false, loadedFg = false, loadedBg = false
  var c0 = "", c4 = "", c7 = "", c8 = ""
  var lines = String(raw || "").split("\n")
  for (var i = 0; i < lines.length; i++) {
    var m = lines[i].match(/^\s*([A-Za-z0-9_-]+)\s*=\s*["']?(#[0-9A-Fa-f]{6})/)
    if (!m) continue
    var key = m[1], value = m[2]
    if (key === "foreground") { out.foreground = value; loadedFg = true }
    else if (key === "background") { out.background = value; loadedBg = true }
    else if (key === "accent") { out.accent = value; foundAccent = true }
    else if (key === "muted") { out.muted = value; foundMuted = true }
    else if (key === "color0") c0 = value
    else if (key === "color4") c4 = value
    else if (key === "color7") c7 = value
    else if (key === "color8") c8 = value
    else if (key === "red" || key === "color1") out.urgent = value
  }
  if (!loadedBg && c0) out.background = c0
  if (!loadedFg && c7) out.foreground = c7
  if (!foundAccent && c4) out.accent = c4
  if (!foundMuted) out.muted = c8 || out.foreground
  return out
}

// Color.parseShell: one TOML walker; numbers stay strings.
function parseShell(raw) {
  var parsed = {}
  var text = String(raw || "")
  if (!text) return parsed
  var lines = text.split("\n")
  var section = ""
  for (var i = 0; i < lines.length; i++) {
    var line = lines[i].replace(/^\s+|\s+$/g, "")
    if (!line || line.charAt(0) === "#") continue
    var sm = line.match(/^\[([A-Za-z0-9_-]+)\]\s*(#.*)?$/)
    if (sm) { section = sm[1]; continue }
    var kv = line.match(/^([A-Za-z0-9_-]+)\s*=\s*["']([^"']+)["']\s*(#.*)?$/) ||
      line.match(/^([A-Za-z0-9_-]+)\s*=\s*(-?\d+(?:\.\d+)?)\s*(#.*)?$/) ||
      line.match(/^([A-Za-z0-9_-]+)\s*=\s*(-?\d+(?:\.\d+)?(?:\s+-?\d+(?:\.\d+)?){1,3})\s*(#.*)?$/) ||
      line.match(/^([A-Za-z0-9_-]+)\s*=\s*([A-Za-z][A-Za-z0-9_-]*)\s*(#.*)?$/)
    if (!kv || !section) continue
    parsed[section + "." + kv[1]] = kv[2]
  }
  return parsed
}

// Color.flatColor: role names, shellValues indirection, transparent.
function flatColor(shellValues, foundation, value, fallback) {
  var seen = {}
  var token = firstColorToken(value)
  var role = String(token || "").replace(/^\s+|\s+$/g, "").toLowerCase()
  while (shellValues[role] && shellValues[role] !== token) {
    if (seen[role]) return fallback
    seen[role] = true
    token = firstColorToken(shellValues[role])
    role = String(token || "").replace(/^\s+|\s+$/g, "").toLowerCase()
  }
  if (role === "foreground" || role === "text") return foundation.foreground
  if (role === "accent") return foundation.accent
  if (role === "urgent") return foundation.urgent
  if (role === "muted") return foundation.muted
  if (role === "background") return foundation.background
  if (role === "transparent") return "rgba(0,0,0,0)"
  var m = token.match(/^-?\d+(\.\d+)?deg$/)
  if (m) return token
  if (token && token.charAt(0) !== "#" && token.indexOf("(") < 0 && shellValues[role] === undefined) return fallback
  return token
}
function firstColorToken(value) {
  var parts = String(value || "").replace(/^\s+|\s+$/g, "").split(/\s+/)
  for (var i = 0; i < parts.length; i++) if (!parts[i].match(/^-?\d+(\.\d+)?deg$/)) return parts[i]
  return value
}
function pick(shellValues, key, fallback) {
  var v = shellValues[key]
  return typeof v === "string" && v.length > 0 ? v : fallback
}
function pickAlpha(shellValues, key, fallback) {
  var v = shellValues[key]
  if (typeof v !== "string" || v.length === 0) return fallback
  var n = Number(v)
  if (!isFinite(n)) return fallback
  return clampAlpha(n)
}
// Color.composed: base-color key + optional -alpha companion.
function composed(shellValues, foundation, colorKey, alphaKey, colorFallback, alphaFallback) {
  var base = flatColor(shellValues, foundation, pick(shellValues, colorKey, colorFallback), colorFallback)
  var rgb = parseColor(base)
  if (rgb) return "rgba(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + "," + pickAlpha(shellValues, alphaKey, alphaFallback) + ")"
  return base
}

// ---- Border.qml surfaceSpec -------------------------------------------
function resolveValueRef(shellValues, raw) {
  var s = String(raw || "").replace(/^\s+|\s+$/g, "")
  var seen = {}
  while (/^[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+$/.test(s) && !seen[s]) {
    seen[s] = true
    var next = shellValues[s]
    if (next === undefined || next === null || String(next).length === 0) break
    s = String(next).replace(/^\s+|\s+$/g, "")
  }
  return s
}
function shellAlpha(shellValues, section, key, fallback) {
  var raw = shellValues[section + "." + key]
  if (String(raw === undefined ? "" : raw).length === 0) return fallback
  var n = Number(raw)
  return isFinite(n) ? clampAlpha(n) : fallback
}
function resolvedGradient(raw, fallbackColor, opacity) {
  var s = String(raw || "").replace(/^\s+|\s+$/g, "")
  if (s.length === 0) s = String(fallbackColor || "")
  var parts = s.split(/\s+/)
  var colors = []
  var angle = 0
  for (var i = 0; i < parts.length; i++) {
    if (parts[i].match(/^-?\d+(\.\d+)?deg$/)) angle = Number(parts[i].replace(/deg$/, ""))
    else colors.push(cssColor(colors.length ? parts[i] : parts[i], opacity))
  }
  if (colors.length === 0) colors.push(cssColor(fallbackColor, opacity))
  return { colors: colors, angle: angle, enabled: colors.length > 1 }
}
// Border.cssColor: role resolution + alpha → CSS color string.
function cssColor(colorValue, opacity) {
  var a = opacity === undefined || opacity === null ? 1 : clampAlpha(opacity)
  var s = String(colorValue || "").replace(/^\s+|\s+$/g, "")
  var role = s.toLowerCase()
  if (role === "foreground" || role === "text") s = FOUNDATION.foreground
  else if (role === "accent") s = FOUNDATION.accent
  else if (role === "urgent") s = FOUNDATION.urgent
  else if (role === "background") s = FOUNDATION.background
  else if (role === "transparent") return "rgba(0,0,0,0)"
  var rgb = parseColor(s)
  if (rgb) return "rgba(" + rgb[0] + "," + rgb[1] + "," + rgb[2] + "," + a + ")"
  if (s.indexOf("rgba(") === 0) return s
  return s
}
function valueOr(shellValues, section, keys) {
  for (var i = 0; i < keys.length; i++) {
    var v = shellValues[section + "." + keys[i]]
    if (String(v === undefined ? "" : v).length > 0) return v
  }
  return ""
}
function surfaceWidths(shellValues, section, token, fallbackWidth) {
  var base = valueOr(shellValues, section, token === "border" ? ["border-width"] : [token + "-width", "border-width"])
  var widths = parseWidthSpec(base, fallbackWidth)
  return withSideOverrides(widths,
    valueOr(shellValues, section, token === "border" ? ["border-width-top"] : [token + "-width-top", "border-width-top"]),
    valueOr(shellValues, section, token === "border" ? ["border-width-right"] : [token + "-width-right", "border-width-right"]),
    valueOr(shellValues, section, token === "border" ? ["border-width-bottom"] : [token + "-width-bottom", "border-width-bottom"]),
    valueOr(shellValues, section, token === "border" ? ["border-width-left"] : [token + "-width-left", "border-width-left"]))
}
function surfaceSpec(shellValues, section, token, fallbackColor, fallbackWidth, alphaKey) {
  var opacity = shellAlpha(shellValues, section, alphaKey || token + "-alpha", 1.0)
  var resolved = resolvedGradient(resolveValueRef(shellValues, shellValues[section + "." + token] || ""),
    fallbackColor, opacity)
  var color0 = resolved.colors.length > 0 ? resolved.colors[0] : cssColor(fallbackColor, opacity)
  return {
    color: color0,
    widths: surfaceWidths(shellValues, section, token, fallbackWidth),
    gradient: { colors: resolved.colors, angle: resolved.angle, enabled: resolved.colors.length > 1 }
  }
}

// ---- Style.qml ---------------------------------------------------------
var STYLE_DEFAULTS = {
  cornerRadius: 0, gapsOut: 5, spacingScale: 1.0, spacingScaleWithFont: true,
  fontBaseSize: 12, styleOverrides: {}, spacingOverrides: {}, fontOverrides: {}
}
var SPACING_TOKENS = { hairline: 1, xxs: 2, xs: 3, sm: 4, md: 6, lg: 8, xl: 10, xxl: 12, xxxl: 14, huge: 18,
  controlGap: 8, controlPaddingX: 10, controlPaddingY: 6, inputPaddingY: 7, controlHeight: 28,
  popupRowHeight: 28, dropdownWidth: 240, searchableDropdownWidth: 260, numberFieldWidth: 120,
  searchablePopupMinHeight: 220, rowGap: 8, rowPaddingX: 12, labelGap: 4, panelGap: 14,
  panelPadding: 18, popupPadding: 14 }
// fontPx multipliers from Style.font at base 12.
var FONT_TOKENS = { caption: 0.833, bodySmall: 0.917, body: 1.0, subtitle: 1.083, title: 1.167,
  heading: 1.333, display: 2.0, displayLarge: 2.333, iconSmall: 0.917, icon: 1.167, iconLarge: 1.5 }

function createStyle() {
  var s = Object.assign({}, STYLE_DEFAULTS)
  s.fontOverrides = {}
  s.spacingOverrides = {}
  s.styleOverrides = {}
  s.fontFamily = "monospace"
  s.reduceMotion = false
  return s
}

// Style.applyShellValues: the [font]/[spacing]/[bar]/[style] pass.
function applyShellValues(style, values) {
  var v = values || {}
  var nextBase = 12, nextSpacingScale = 1.0, nextSpacingScaleWithFont = true
  var fontOut = {}, spacingOut = {}, styleOut = {}
  for (var fullKey in v) {
    var dot = fullKey.indexOf(".")
    if (dot < 0) continue
    var section = fullKey.substr(0, dot), key = fullKey.substr(dot + 1), raw = v[fullKey]
    if (section === "font") {
      var ival = parseInt(raw, 10)
      if (!isFinite(ival)) continue
      if (key === "base-size") nextBase = ival
      else fontOut[key] = ival
    } else if (section === "spacing") {
      if (key === "scale-with-font") nextSpacingScaleWithFont = boolToken(raw, nextSpacingScaleWithFont)
      else {
        var fval = parseFloat(raw)
        if (!isFinite(fval)) continue
        if (key === "scale") nextSpacingScale = fval
        else spacingOut[key] = fval
      }
    } else if (section === "controls" || section === "style") {
      styleOut[key] = raw
    }
  }
  if (!isFinite(nextBase) || nextBase < 1) nextBase = 1
  if (!isFinite(nextSpacingScale) || nextSpacingScale < 0) nextSpacingScale = 1.0
  style.spacingScale = nextSpacingScale
  style.spacingScaleWithFont = nextSpacingScaleWithFont
  style.fontBaseSize = nextBase
  style.fontOverrides = fontOut
  style.spacingOverrides = spacingOut
  style.styleOverrides = styleOut
}
function boolToken(value, fallback) {
  if (value === undefined || value === null) return fallback
  var t = String(value).replace(/^\s+|\s+$/g, "").toLowerCase()
  if (t === "true" || t === "1" || t === "yes" || t === "on") return true
  if (t === "false" || t === "0" || t === "no" || t === "off") return false
  return fallback
}
function fontScale(style) { return Math.max(1 / 12, style.fontBaseSize / 12) }
function effectiveSpacingScale(style) { return style.spacingScale * (style.spacingScaleWithFont ? fontScale(style) : 1) }
// Style.space(px)
function space(style, px) {
  var n = Number(px)
  if (!isFinite(n) || n <= 0) return 0
  n = n * effectiveSpacingScale(style)
  if (n <= 0) return 0
  return Math.max(1, Math.round(n))
}
function spacingToken(style, key, fallback) {
  var v = style.spacingOverrides[key]
  var n = Number(v)
  return isFinite(n) && n >= 0 ? Math.round(n) : space(style, fallback)
}
function fontToken(style, key, fallback) {
  var v = style.fontOverrides[key]
  var n = Number(v)
  return isFinite(n) && n > 0 ? Math.round(n) : fallback
}
function fontPx(style, mult) { return Math.max(1, Math.round(style.fontBaseSize * mult)) }
function font(style, key) { return fontToken(style, key, fontPx(style, FONT_TOKENS[key])) }

// The full bundle the window binds to: foundation palette + shell values +
// style tokens + the card's borderSpec, as the QML window assembles them.
function createTheme(opts) {
  opts = opts || {}
  var foundation = loadColors(opts.colorsRaw)
  var shellValues = parseShell(opts.shellRaw)
  var style = createStyle()
  applyShellValues(style, shellValues)
  if (opts.gapsOut !== undefined) style.gapsOut = opts.gapsOut
  if (opts.cornerRadius !== undefined) style.cornerRadius = opts.cornerRadius
  if (opts.fontFamily) style.fontFamily = opts.fontFamily

  var theme = {
    foundation: foundation,
    shellValues: shellValues,
    style: style,
    // Commons.Color.menu.* as the window's `look` base.
    menu: {
      background: composed(shellValues, foundation, "menu.background", "menu.background-alpha", foundation.background, 1.0),
      text: pick(shellValues, "menu.text", foundation.foreground),
      border: composed(shellValues, foundation, "menu.border", "menu.border-alpha", foundation.foreground, 1.0),
      scrim: composed(shellValues, foundation, "menu.scrim", "menu.scrim-alpha", foundation.background, 0.5),
      selectedBackground: composed(shellValues, foundation, "menu.selected-background", "menu.selected-background-alpha", foundation.foreground, 0.08),
      selectedText: pick(shellValues, "menu.selected-text", foundation.accent),
      selectedBorder: composed(shellValues, foundation, "menu.selected-border", "menu.selected-border-alpha", foundation.foreground, 0.0)
    }
  }

  // Border.surfaceSpec("menu", "border", Color.menu.border, max(1, space(2))).
  theme.borderSpec = surfaceSpec(shellValues, "menu", "border", theme.menu.border, Math.max(1, space(style, 2)))

  theme.space = function(px) { return space(style, px) }
  theme.font = function(key) { return font(style, key) }
  theme.spacing = function(key) { return spacingToken(style, key, SPACING_TOKENS[key]) }
  theme.alpha = alpha
  // The window's `look`.
  theme.look = function() {
    return {
      background: theme.menu.background,
      foreground: theme.menu.text,
      accent: theme.menu.selectedText,
      selectedBackground: theme.menu.selectedBackground,
      fontFamily: style.fontFamily
    }
  }
  return theme
}

if (typeof module !== "undefined") {
  module.exports = {
    clamp: clamp, clampAlpha: clampAlpha, alpha: alpha, parseColor: parseColor,
    parseWidthSpec: parseWidthSpec, withSideOverrides: withSideOverrides, maxWidth: maxWidth,
    needsOverlay: needsOverlay, canUseNative: canUseNative,
    loadColors: loadColors, parseShell: parseShell, composed: composed, flatColor: flatColor,
    surfaceSpec: surfaceSpec, cssColor: cssColor,
    createStyle: createStyle, applyShellValues: applyShellValues, space: space, font: font,
    createTheme: createTheme, SPACING_TOKENS: SPACING_TOKENS, FONT_TOKENS: FONT_TOKENS
  }
}
