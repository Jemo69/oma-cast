# oma-cast for Windows (Electron)

The Windows port of oma-cast: a Raycast-style launcher that keeps the
Omarchy build's behaviour and its **pixel-faithful UI**. Every layout value,
colour and animation comes from the same sources the QML build uses —
Omarchy's `Style`/`Color` tokens and this repo's `plugin/ui/*.qml` — ported
component-for-component rather than redesigned. [D]

```
main.js            host layer: overlay window, Alt+Space hotkey, CLI pipe,
                   paste orchestration (SendInput), HUD toasts
src/backend.js     port of plugin/Backend.qml (same RPC surface, same names)
src/theme/         port of omarchy-theme-color / -set-templates + the
                   Color/Style/Border singletons (exact token resolution)
src/json-store.js  port of services/JsonStore.qml (fs + atomic + 250 ms)
src/calculator-data.js  ECB rates (frankfurter.dev) + Intl time zones
src/apps.js        Start Menu .lnk library: enumerate, icons, launch
src/host.js        renderer-side adapters (clipboard, paste, external, agent)
src/windows-settings.js  ms-settings: page table for the Windows Settings view
ui/index.html      the launcher surface
ui/style.css       px-for-px port of the QML geometry at zoom 1
ui/app.js          theme + geometry + header (LauncherWindow top half)
ui/view.js         rows/panels/footer/alert (ResultRow, ActionPanel, …)
ui/keys.js         navigation + the complete handleKey port
bin/oma-cast.ps1   CLI: toggle/show/hide/run/call/doctor/install
themes/            Omarchy's shell.toml.tpl + Tokyo Night colors.toml
assets/            omarchy.ttf (MIT) + JetBrainsMono Nerd Font (OFL)
```

## Run

```sh
cd electron
npm install        # devDependencies: electron + electron-builder
npm start          # the launcher; hotkey Alt+Space
npm test           # node --test: the shared core tests + this port's tests
npm run dist       # Windows: NSIS installer → dist/oma-cast-<version>-setup.exe
```

CI builds the installer on every push (`build-windows` job) and uploads
`oma-cast-setup-win32-x64` — the setup exe, per-user install (no admin),
Start Menu + desktop shortcut, Omarchy-logo icon rendered from
`assets/omarchy.ttf`.

> **Why `asarUnpack: assets/**`:** Chromium memory-maps font files and
> mmap cannot pass through Electron's asar patch, so fonts packed inside
> `app.asar` fail silently — every Nerd Font glyph renders as tofu. The
> fonts live in `app.asar.unpacked/assets/` (real files on disk); the
> `file://…app.asar/assets/…` URLs in `style.css` keep working through
> Electron's transparent unpacked redirect. The CI layout check asserts
> both locations.

`oma-cast.ps1` speaks JSON-lines to the running app over `\\.\pipe\oma-cast`
(the IpcHandler contract from the Linux build):

```powershell
bin\oma-cast.ps1 toggle
bin\oma-cast.ps1 call system.info
bin\oma-cast.ps1 run builtin:calculator-history
bin\oma-cast.ps1 doctor
bin\oma-cast.ps1 install     # PATH shim in %LOCALAPPDATA%\oma-cast\bin + Startup shortcut
```

## What is shared with the Linux build

Everything under `plugin/core/` runs unchanged: `Ranker` (the exact
ref-02 §4 ranking), `Frecency`, `Calculator`, `RootSearch`, `Schema`,
`Migrate`, `Rpc`, `Log`, plus the newer `FileSearch`, `SettingsView`. The golden tests in `../tests/` cover the same
files for both platforms; the Electron port adds tests for its own ports
(theme resolution golden against the real Omarchy template, the store, the
backend surface).

The UI is a DOM port of the QML components — same `px()` scale
(`Style.space × uiZoom`), same font scale (base 12: caption 10 … heading
16), same colours (`Color.menu.*`), same geometry formulas (card
`min(px(750), w−2·gapsOut)` × `min(px(475), h−2·gapsOut)` at
`y = max(gapsOut, min(h/4, …))`), same 530 ms caret blink, same 900 ms
loader sweep. The Omarchy icon font (`U+E900` logo) and every Nerd Font
glyph (`U+F0xx`, `U+F06A9`, …) are the exact same codepoints in the same
fonts — `omarchy.ttf` and JetBrainsMono Nerd Font are bundled, so text and
icons match the Omarchy default out of the box.

Themes resolve through the real Omarchy pipeline: `themes/shell.toml.tpl`
rendered against `themes/tokyo-night/colors.toml` with the same token,
mix (awk rounding included) and gradient functions as
`omarchy-theme-set-templates`. Tokyo Night is Omarchy's default theme; to
port another one, replace `themes/tokyo-night/`. A live theme-switcher
mirroring `omarchy theme set` is not wired up (Phase 2 territory). [D]

## Built-in commands beyond the Linux build

| command | what it does |
|---|---|
| **File search** | a Files section in root search (SPEC §8.6 slice): name match first, then path, recency within a tier; Open / Reveal in Explorer / Copy Path. Chunked walk of home (or `fileSearchScopes`), 100k cap, 10-min re-walk, disk cache — no inotify watcher yet [D] |
| **Settings** | the Phase-2 stub made real: a pushed view over every window/hotkey/search/calculator setting; ↵ cycles values, `hotkey` re-registers immediately |
| **Kill Process** | running processes by memory (PowerShell snapshot), confirm-first destructive alert, `taskkill /F`, Reveal + Copy PID |
| **Search unduck** | `https://unduck.link?q=%s` as both a root fallback row and a quicklink with an argument pill |
| **Windows Settings** | a pushed, searchable list of the Settings app's own `ms-settings:` deep links grouped by category (Themes, Display, Windows Update, privacy, …); also the first row of the launcher's Settings view. ↵ opens the page through `shell.openExternal` [D] |
| **Shut Down / Restart / Sleep** | the Omarchy system actions' Windows equivalents: the first two ask the destructive confirm, then schedule `shutdown /s|/r /t 15` with a **Cancel** toast (`shutdown /a`); Sleep closes the window first and suspends via `SetSuspendState` (with hibernation enabled Windows hibernates instead) [D] |

There is **no extension runtime** yet (SPEC Phase 5/§9): new capabilities
land as built-ins in `plugin/core/RootSearch.js` + a service, which is how
all five above were added.

## Windows substitutions [D]

| Omarchy | Windows |
|---|---|
| `shell.appLibrary` | Start Menu `.lnk` scan (user + machine scope) through one PowerShell pass; icons extracted with `System.Drawing.Icon` into a PNG cache; launch via `explorer.exe` (ShellExecute, UAC-aware) |
| layer-shell overlay + exclusive keyboard focus | one frameless transparent window covering the monitor under the cursor (`alwaysOnTop: screen-saver`, no taskbar entry); blur dismisses unless `keepVisibleOnFocusLoss` |
| `wl-copy` / `omarchy-clipboard-paste-text` | Electron clipboard; paste = hide window, then Ctrl+V via `keybd_event` |
| `omarchy-shell osd` HUD | Windows toast (`Notification`) |
| `omarchy-agent` hand-off | `agentCommand` template in config.json with `{prompt}` substitution, preflighted with `where.exe` (5 s cap) — the same bounded, question-free check; the fallback row explains how to enable it when unset |
| Omarchy Menu provider + guards | dropped: there is no omarchy-shell to summon; the summon-only builtin is filtered from candidates |
| `hyprctl` corner rounding / gaps | `cornerRadius` / `gapsOut` config keys (same defaults Style falls back to: 0 / 5) |
| Hyprland `hyprctl` dispatches | none yet (Phase 6 equivalent) |

## config.json (`%APPDATA%\oma-cast\config.json`)

Everything the Linux build accepts (`logLevel`, `keepVisibleOnFocusLoss`,
`currencyRates`, `remToPxRate`, `workHoursPerDay`, `clockFormat`), plus:

| key | default | meaning |
|---|---|---|
| `hotkey` | `"Alt+Space"` | Electron accelerator for toggle |
| `fontFamily` | `""` (bundled JetBrainsMono Nerd Font stack) | UI font stack override |
| `agentCommand` | `""` | e.g. `"wt.exe claude {prompt}"`; empty disables the hand-off |
| `gapsOut` | `5` | card-to-screen-edge gap (Style's fallback) |
| `cornerRadius` | `0` | window rounding (Hyprland fallback) |
| `fileSearchScopes` | `[]` (home dir) | directories the file index walks |
| `fileSearchIncludeHidden` | `false` | index dotfiles/hidden files |

Data lives in `%LOCALAPPDATA%\oma-cast` (`db\settings.json`,
`db\frecency.json`, `db\calculator.json`, cache, logs); config in
`%APPDATA%\oma-cast` — the same key set as the XDG layout
(`plugin/core/Paths.js resolveWindows`).

## Verifying on a real Windows machine

This port was written on Linux; unit tests and a headless boot cover the
logic, but these need a live Windows box: hotkey registration (Alt+Space
stealing from the focused window's system menu), paste timing
(`keybd_event` after unmap), Start Menu enumeration + icon extraction,
multi-monitor placement under the cursor, DPI scaling (`uiZoom` × display
scale), toasts, and UAC-gated shortcuts. `bin\oma-cast.ps1 doctor` reports
the state; the same checklist as `tests/smoke.sh` applies.
