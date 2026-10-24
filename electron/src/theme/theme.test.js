// Golden tests for the Windows theme pipeline: the Omarchy template
// renderer + Color/Style surface resolution must produce exactly what the
// shell resolves for Tokyo Night (the bundled default theme).
const test = require("node:test")
const assert = require("node:assert")
const fs = require("node:fs")
const path = require("node:path")
const color = require("./color")
const render = require("./render")
const surface = require("./surface")

const themeDir = path.join(__dirname, "..", "..", "themes")
const colorsRaw = fs.readFileSync(path.join(themeDir, "tokyo-night", "colors.toml"), "utf8")
const tpl = fs.readFileSync(path.join(themeDir, "shell.toml.tpl"), "utf8")

test("mixColor rounds exactly like awk int(x + 0.5)", () => {
  assert.equal(color.mixColor("#f7768e", "#ffffff", "20%"), "#f991a5")
  assert.equal(color.mixColor("#1a1b26", "#ffffff", "20%"), "#484951")
  // fractions; bare numbers above 1 are percentages (the bash rule)
  assert.equal(color.mixColor("#000000", "#ffffff", "0.5"), "#808080")
  assert.equal(color.mixColor("#000000", "#ffffff", "2"), "#050505")
  assert.equal(color.mixColor("#000000", "#ffffff", "-1"), "#000000")
})

test("color.resolve applies the alias/derived cascade", () => {
  const c = color.resolve(colorsRaw, false)
  assert.equal(c.background, "#1a1b26")
  assert.equal(c.foreground, "#a9b1d6")
  assert.equal(c.accent, "#7aa2f7")
  assert.equal(c.color0, "#1a1b26")
  assert.equal(c.color7, "#a9b1d6")
  assert.equal(c.bright_red, "#ff7a93")   // theme-defined
  assert.equal(c.cursor, "#c0caf5")
  assert.equal(c.mode, "dark")
  assert.equal(c.theme_type, "dark")
})

test("derived shades mix like the bash resolver when absent", () => {
  const c = color.resolve('background = "#202020"\nred = "#ff0000"\n', false)
  assert.equal(c.dark_background, "#181818")   // mix(bg, black, 25%)
  assert.equal(c.darker_background, "#101010") // mix(bg, black, 50%)
  assert.equal(c.bright_red, "#ff3333")        // mix(red, white, 20%)
  assert.equal(c.red, "#ff0000")
  assert.equal(c.urgent, undefined)            // urgent is Color.qml's job, not the palette's
})

test("renderShell renders the real template with no leftover tokens", () => {
  const shell = render.renderShell(colorsRaw, tpl, false)
  assert.equal((shell.match(/\{\{[^}]*\}\}/g) || []).length, 0)
  // The flat dictionary the surface layer consumes — exactly how
  // createTheme reads the rendered file.
  const parsed = surface.parseShell(shell)
  assert.equal(parsed["hyprland.active-border"], "#7aa2f7")
  assert.equal(parsed["hyprland.active-border-foreground"], "#a9b1d6")
  assert.equal(parsed["menu.border"], "hyprland.active-border-foreground")
  assert.equal(parsed["menu.border-alpha"], "1.0")
  assert.equal(parsed["menu.selected-text"], "#7aa2f7")
  assert.equal(parsed["font.base-size"], "12")
  assert.equal(parsed["spacing.scale"], "1.0")
})

test("createTheme resolves the window look and card border exactly", () => {
  const shell = render.renderShell(colorsRaw, tpl, false)
  const theme = surface.createTheme({ colorsRaw: colorsRaw, shellRaw: shell })
  const look = theme.look()
  // Foundation from colors.toml (Color.loadColors: red → urgent).
  assert.equal(theme.foundation.urgent, "#f7768e")
  // Color.menu.* for Tokyo Night at default alphas.
  assert.equal(look.background, "rgba(26,27,38,1)")
  assert.equal(look.foreground, "#a9b1d6")
  assert.equal(look.accent, "#7aa2f7")
  assert.equal(look.selectedBackground, "rgba(169,177,214,0.08)")
  // Border.surfaceSpec("menu", "border", …, max(1, space(2))): solid
  // foreground at alpha 1.0, uniform 2 px — the native Rectangle path.
  assert.equal(theme.borderSpec.color, "rgba(169,177,214,1)")
  assert.deepEqual(theme.borderSpec.widths, { top: 2, right: 2, bottom: 2, left: 2 })
  assert.equal(theme.borderSpec.gradient.enabled, false)
  assert.equal(surface.canUseNative(theme.borderSpec), true)
  // Style fallbacks without Hyprland: cornerRadius 0, gapsOut 5.
  assert.equal(theme.style.cornerRadius, 0)
  assert.equal(theme.style.gapsOut, 5)
  // Spacing/type scale at base 12.
  assert.equal(theme.space(1), 1)
  assert.equal(theme.spacing("hairline"), 1)
  assert.equal(theme.spacing("huge"), 18)
  assert.equal(theme.font("caption"), 10)
  assert.equal(theme.font("bodySmall"), 11)
  assert.equal(theme.font("heading"), 16)
})

test("a gradient border theme takes the BorderOverlay path", () => {
  const shellRaw = [
    "[menu]",
    'border = "#111111 #222222 45deg"',
    "border-alpha = 1.0"
  ].join("\n")
  const theme = surface.createTheme({ colorsRaw: "", shellRaw: shellRaw })
  assert.equal(theme.borderSpec.gradient.enabled, true)
  assert.equal(theme.borderSpec.gradient.angle, 45)
  assert.equal(surface.needsOverlay(theme.borderSpec), true)
  assert.equal(surface.canUseNative(theme.borderSpec), false)
})

test("parseShell keeps the flat section.key dictionary", () => {
  const parsed = surface.parseShell('[menu]\nbackground = "#000000"\nbackground-alpha = 0.9\n\n[font]\nbase-size = 14\n')
  assert.equal(parsed["menu.background"], "#000000")
  assert.equal(parsed["menu.background-alpha"], "0.9")
  assert.equal(parsed["font.base-size"], "14")
  // font base-size flows into the type scale.
  const theme = surface.createTheme({ colorsRaw: "", shellRaw: '[font]\nbase-size = 14\n' })
  assert.equal(theme.font("body"), 14)
  assert.equal(theme.font("heading"), Math.round(14 * 1.333))
})
