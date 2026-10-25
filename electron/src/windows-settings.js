// Windows Settings pages, browsed from the pushed "Windows Settings"
// view — Raycast's System Settings command, Windows edition. The
// `ms-settings:` URIs are the Settings app's own deep links (documented
// by Microsoft, stable across Windows 10 and 11, no elevation needed);
// a page that a build does not know simply does nothing. Pure: page
// table + filtering, the backend opens a page through host.openExternal.
// The launcher's own preferences stay in plugin/core/SettingsView.js. [D]

var PAGES = [
  // System
  { uri: "ms-settings:display", title: "Display", category: "System", keywords: "monitor resolution scaling night light brightness" },
  { uri: "ms-settings:sound", title: "Sound", category: "System", keywords: "volume output input microphone mixer" },
  { uri: "ms-settings:notifications", title: "Notifications", category: "System", keywords: "alerts focus do not disturb banners" },
  { uri: "ms-settings:powersleep", title: "Power & battery", category: "System", keywords: "power energy battery sleep plan" },
  { uri: "ms-settings:storage", title: "Storage", category: "System", keywords: "disk space cleanup sense files" },
  { uri: "ms-settings:multitasking", title: "Multitasking", category: "System", keywords: "snap windows virtual desktops" },
  { uri: "ms-settings:clipboard", title: "Clipboard", category: "System", keywords: "copy paste history" },
  { uri: "ms-settings:fileexplorer", title: "File Explorer", category: "System", keywords: "explorer folders extensions open with" },
  { uri: "ms-settings:about", title: "About", category: "System", keywords: "device specs rename this pc windows specs" },
  { uri: "ms-settings:remote-desktop", title: "Remote Desktop", category: "System", keywords: "rdp remote access" },
  { uri: "ms-settings:proximity", title: "Nearby sharing", category: "System", keywords: "share discover devices" },
  { uri: "ms-settings:quietmoments", title: "Focus", category: "System", keywords: "quiet hours focus session do not disturb" },

  // Bluetooth & devices
  { uri: "ms-settings:bluetooth", title: "Bluetooth & devices", category: "Bluetooth & devices", keywords: "pair wireless mouse keyboard headset" },
  { uri: "ms-settings:devices", title: "Devices", category: "Bluetooth & devices", keywords: "connected devices" },
  { uri: "ms-settings:mouse", title: "Mouse", category: "Bluetooth & devices", keywords: "pointer buttons scroll speed" },
  { uri: "ms-settings:typing", title: "Typing", category: "Bluetooth & devices", keywords: "keyboard autocorrect suggestions" },
  { uri: "ms-settings:printers", title: "Printers & scanners", category: "Bluetooth & devices", keywords: "printer scanner print queue" },
  { uri: "ms-settings:autoplay", title: "AutoPlay", category: "Bluetooth & devices", keywords: "usb drive dvd default action" },

  // Network & internet
  { uri: "ms-settings:network-status", title: "Wi-Fi & network", category: "Network & internet", keywords: "network status internet connection" },
  { uri: "ms-settings:network-wifi", title: "Wi-Fi", category: "Network & internet", keywords: "wireless networks ssid hotspot" },
  { uri: "ms-settings:network-ethernet", title: "Ethernet", category: "Network & internet", keywords: "wired lan adapter" },
  { uri: "ms-settings:network-vpn", title: "VPN", category: "Network & internet", keywords: "virtual private network tunnel" },
  { uri: "ms-settings:network-airplanemode", title: "Airplane mode", category: "Network & internet", keywords: "flight mode radio off" },
  { uri: "ms-settings:network-mobilehotspot", title: "Mobile hotspot", category: "Network & internet", keywords: "tether share phone" },
  { uri: "ms-settings:network-proxy", title: "Proxy", category: "Network & internet", keywords: "proxy server manual auto config" },
  { uri: "ms-settings:datausage", title: "Data usage", category: "Network & internet", keywords: "metered limit bandwidth" },

  // Personalization
  { uri: "ms-settings:personalization", title: "Personalization", category: "Personalization", keywords: "looks appearance customise customize" },
  { uri: "ms-settings:personalization-themes", title: "Themes", category: "Personalization", keywords: "theme dark light colour color mode contrast" },
  { uri: "ms-settings:personalization-colors", title: "Colors", category: "Personalization", keywords: "accent colour color taskbar transparency" },
  { uri: "ms-settings:personalization-background", title: "Background", category: "Personalization", keywords: "wallpaper desktop picture slideshow" },
  { uri: "ms-settings:personalization-start", title: "Start", category: "Personalization", keywords: "start menu pins layout" },
  { uri: "ms-settings:lockscreen", title: "Lock screen", category: "Personalization", keywords: "lockscreen screensaver windows spotlight" },
  { uri: "ms-settings:taskbar", title: "Taskbar", category: "Personalization", keywords: "tray icons system tray corner" },
  { uri: "ms-settings:fonts", title: "Fonts", category: "Personalization", keywords: "typeface install font" },
  { uri: "ms-settings:contextmenus", title: "Context menus", category: "Personalization", keywords: "right click share menu" },

  // Apps
  { uri: "ms-settings:appsfeatures", title: "Installed apps", category: "Apps", keywords: "uninstall remove program apps" },
  { uri: "ms-settings:defaultapps", title: "Default apps", category: "Apps", keywords: "file type association browser default" },
  { uri: "ms-settings:optionalfeatures", title: "Optional features", category: "Apps", keywords: "add remove windows components" },
  { uri: "ms-settings:startupapps", title: "Startup apps", category: "Apps", keywords: "boot autorun launch login" },
  { uri: "ms-settings:offlineapps", title: "Offline maps", category: "Apps", keywords: "maps download" },

  // Accounts
  { uri: "ms-settings:yourinfo", title: "Your info", category: "Accounts", keywords: "avatar account picture" },
  { uri: "ms-settings:signinoptions", title: "Sign-in options", category: "Accounts", keywords: "password pin hello face fingerprint windows hello" },
  { uri: "ms-settings:otherusers", title: "Other users", category: "Accounts", keywords: "family account add user" },
  { uri: "ms-settings:workaccess", title: "Work or school access", category: "Accounts", keywords: "domain azure ad join workplace" },
  { uri: "ms-settings:email", title: "Email & accounts", category: "Accounts", keywords: "mail calendar accounts sync" },
  { uri: "ms-settings:sync", title: "Windows sync", category: "Accounts", keywords: "sync settings roaming" },
  { uri: "ms-settings:windowsbackup", title: "Windows backup", category: "Accounts", keywords: "backup restore folder sync" },

  // Time & language
  { uri: "ms-settings:dateandtime", title: "Date & time", category: "Time & language", keywords: "clock timezone ntp calendar" },
  { uri: "ms-settings:regionlanguage", title: "Language & region", category: "Time & language", keywords: "language locale country region keyboard" },
  { uri: "ms-settings:speech", title: "Speech", category: "Time & language", keywords: "voice recognition dictation" },
  { uri: "ms-settings:keyboard", title: "Keyboard", category: "Time & language", keywords: "input language shortcut repeat rate" },

  // Gaming
  { uri: "ms-settings:gaming-gamebar", title: "Game Bar", category: "Gaming", keywords: "capture record screenshot overlay" },
  { uri: "ms-settings:gaming-gamemode", title: "Game Mode", category: "Gaming", keywords: "performance fps optimise optimize" },

  // Accessibility
  { uri: "ms-settings:accessibility", title: "Accessibility", category: "Accessibility", keywords: "ease of access vision hearing interaction" },
  { uri: "ms-settings:contrastthemes", title: "Contrast themes", category: "Accessibility", keywords: "high contrast theme colour blindness" },
  { uri: "ms-settings:magnifier", title: "Magnifier", category: "Accessibility", keywords: "zoom screen enlarge" },
  { uri: "ms-settings:narrator", title: "Narrator", category: "Accessibility", keywords: "screen reader voice over" },
  { uri: "ms-settings:closedcaptioning", title: "Captions", category: "Accessibility", keywords: "subtitle closed caption" },
  { uri: "ms-settings:mousepointers", title: "Mouse pointer", category: "Accessibility", keywords: "cursor size touch feedback" },

  // Privacy & security
  { uri: "ms-settings:privacy", title: "Privacy", category: "Privacy & security", keywords: "permissions general privacy" },
  { uri: "ms-settings:privacy-location", title: "Location", category: "Privacy & security", keywords: "gps geolocation permissions" },
  { uri: "ms-settings:privacy-microphone", title: "Microphone", category: "Privacy & security", keywords: "camera audio app permissions" },
  { uri: "ms-settings:privacy-webcam", title: "Camera", category: "Privacy & security", keywords: "webcam video app permissions" },
  { uri: "ms-settings:privacy-speech", title: "Speech", category: "Privacy & security", keywords: "voice typing online speech recognition" },
  { uri: "ms-settings:windowsdefender", title: "Windows Security", category: "Privacy & security", keywords: "antivirus firewall defender virus threat" },
  { uri: "ms-settings:findmydevice", title: "Find my device", category: "Privacy & security", keywords: "locate lost device gps" },
  { uri: "ms-settings:deviceencryption", title: "Device encryption", category: "Privacy & security", keywords: "bitlocker encrypt drive" },

  // Windows Update
  { uri: "ms-settings:windowsupdate", title: "Windows Update", category: "Windows Update", keywords: "update patch upgrade windows" },
  { uri: "ms-settings:windowsupdate-history", title: "Update history", category: "Windows Update", keywords: "installed updates patch history" },
  { uri: "ms-settings:windowsupdate-options", title: "Advanced options", category: "Windows Update", keywords: "pause updates delivery optimisation" },
  { uri: "ms-settings:windowsinsider", title: "Windows Insider Program", category: "Windows Update", keywords: "beta preview dev canary ring" }
]

function tokens(query) {
  var q = String(query || "").trim().toLowerCase()
  return q ? q.split(/\s+/) : []
}

function matches(page, q) {
  if (q.length === 0) return true
  var hay = (page.title + " " + page.category + " " + page.uri + " " + page.keywords).toLowerCase()
  for (var i = 0; i < q.length; i++) if (hay.indexOf(q[i]) < 0) return false
  return true
}

function candidate(page) {
  return {
    id: "winset:" + page.uri,
    type: "command",
    kind: "windows-setting",
    title: page.title,
    subtitle: page.category,
    typeLabel: "",
    rootSearch: { when: "searching" }
  }
}

function rows(query) {
  var q = tokens(query)
  var out = []
  for (var i = 0; i < PAGES.length; i++) if (matches(PAGES[i], q)) out.push(candidate(PAGES[i]))
  return out
}

// Grouped by category, in table order — the browse view for an empty
// query, still narrowed in place while typing.
function sections(query) {
  var q = tokens(query)
  var out = []
  for (var i = 0; i < PAGES.length; i++) {
    if (!matches(PAGES[i], q)) continue
    var last = out.length ? out[out.length - 1] : null
    if (last && last.title === PAGES[i].category) last.rows.push(candidate(PAGES[i]))
    else out.push({ id: "winset-" + PAGES[i].category.toLowerCase().replace(/[^a-z0-9]+/g, "-"), title: PAGES[i].category, rows: [candidate(PAGES[i])] })
  }
  return out
}

function find(uri) {
  var wanted = String(uri || "")
  for (var i = 0; i < PAGES.length; i++) if (PAGES[i].uri === wanted) return PAGES[i]
  return null
}

function actionsFor() {
  return [{ id: "open", title: "Open Settings Page", shortcut: "↵", section: "primary", icon: "" }]
}

if (typeof module !== "undefined") {
  module.exports = { PAGES: PAGES, rows: rows, sections: sections, find: find, actionsFor: actionsFor }
}
