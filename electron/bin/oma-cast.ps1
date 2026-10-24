# oma-cast for Windows — the CLI twin of bin/oma-cast.
# Talks JSON-lines to the running app over the named pipe \\.\pipe\oma-cast
# (the IpcHandler contract: toggle/show/hide/isOpen/ping/run/call).
#
#   oma-cast toggle | show | hide | isOpen | ping
#   oma-cast run <commandId>            # skips confirmation alerts
#   oma-cast call <method> [json]       # e.g. oma-cast call system.info
#   oma-cast start                      # launch the app if it isn't running
#   oma-cast doctor                     # environment and configuration check
#   oma-cast install                    # PATH shim + Startup shortcut
param(
  [Parameter(Position = 0)] [string]$Command = "help",
  [Parameter(Position = 1, ValueFromRemainingArguments = $true)] $Rest
)
$ErrorActionPreference = "Stop"
$PipeName = "oma-cast"
$RepoRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path

function Send-OmaCast([hashtable]$Request) {
  $json = $Request | ConvertTo-Json -Compress -Depth 6
  $client = New-Object System.IO.Pipes.NamedPipeClientStream(".", $PipeName, [System.IO.Pipes.PipeDirection]::InOut)
  $client.Connect(3000)
  $writer = New-Object System.IO.StreamWriter($client)
  $writer.AutoFlush = $true
  $writer.WriteLine($json)
  $reader = New-Object System.IO.StreamReader($client)
  $line = $reader.ReadLine()
  $writer.Dispose(); $reader.Dispose(); $client.Dispose()
  if ($null -eq $line) { throw "oma-cast did not answer on the $PipeName pipe" }
  return $line | ConvertFrom-Json
}

function Invoke-Request([hashtable]$Request) {
  $response = Send-OmaCast $Request
  if (-not $response.ok) {
    [Console]::Error.WriteLine("oma-cast: " + $response.error)
    exit 1
  }
  if ($null -ne $response.data) {
    if ($response.data -is [string]) { Write-Output $response.data }
    else { $response.data | ConvertTo-Json -Depth 6 }
  }
  exit 0
}

function Test-Running {
  try { $null = Send-OmaCast @{ method = "ping" }; return $true } catch { return $false }
}

function Start-OmaCast {
  if (Test-Running) { Write-Output "already running"; return }
  # npx resolves the locally installed electron; detached like
  # Quickshell's execDetached so the CLI can exit immediately.
  Start-Process -FilePath "npx" -ArgumentList "electron", "." -WorkingDirectory $RepoRoot -WindowStyle Hidden
  Write-Output "starting"
}

function Install-OmaCast {
  $appData = $env:LOCALAPPDATA
  $shimDir = Join-Path $appData "oma-cast\bin"
  New-Item -ItemType Directory -Force -Path $shimDir | Out-Null
  Copy-Item (Join-Path $PSScriptRoot "oma-cast.ps1") (Join-Path $shimDir "oma-cast.ps1") -Force
  Copy-Item (Join-Path $PSScriptRoot "oma-cast.cmd") (Join-Path $shimDir "oma-cast.cmd") -Force

  # Autostart: a Startup-folder shortcut that runs the launcher hidden.
  $startup = [Environment]::GetFolderPath("Startup")
  $shortcutPath = Join-Path $startup "oma-cast.lnk"
  $shell = New-Object -ComObject WScript.Shell
  $shortcut = $shell.CreateShortcut($shortcutPath)
  $shortcut.TargetPath = "powershell.exe"
  $shortcut.Arguments = "-NoProfile -WindowStyle Hidden -ExecutionPolicy Bypass -File `"$(Join-Path $shimDir 'oma-cast.ps1')`" start"
  $shortcut.WindowStyle = 7
  $shortcut.Save()

  Write-Output "installed: $shimDir (add it to PATH), autostart: $shortcutPath"
  if (-not (Test-Running)) { Write-Output "run 'oma-cast start' (or log in again) to launch it" }
}

function Invoke-Doctor {
  Write-Output "repo:        $RepoRoot"
  Write-Output "electron:    $(if (Test-Path (Join-Path $RepoRoot 'node_modules\.bin\electron.cmd')) { 'installed' } else { 'MISSING - run npm install' })"
  $paths = Join-Path $env:APPDATA "oma-cast"
  $configFile = Join-Path $paths "config.json"
  Write-Output "config:      $configFile"
  if (Test-Path $configFile) {
    Write-Output "config body: $((Get-Content $configFile -Raw) -replace '\s+', ' ').Trim()"
  } else {
    Write-Output "config body: (none yet - defaults: hotkey Alt+Space)"
  }
  $dbDir = Join-Path $env:LOCALAPPDATA "oma-cast\db"
  Write-Output "db:          $dbDir $(if (Test-Path $dbDir) { '(exists)' } else { '(created on first run)' })"
  $running = Test-Running
  Write-Output "running:     $(if ($running) { 'yes' } else { 'no - run: oma-cast start' })"
  if ($running) {
    $info = Invoke-Request @{ method = "call"; data = @{ method = "system.info"; data = $null } }
    Write-Output "version:     $($info.version) on $($info.desktop), $($info.candidates) candidates, ready=$($info.ready)"
  }
  exit 0
}

switch ($Command) {
  "toggle"   { Invoke-Request @{ method = "toggle" } }
  "show"     { Invoke-Request @{ method = "show" } }
  "hide"     { Invoke-Request @{ method = "hide" } }
  "isOpen"   { Invoke-Request @{ method = "isOpen" } }
  "ping"     { Invoke-Request @{ method = "ping" } }
  "start"    { Start-OmaCast }
  "install"  { Install-OmaCast }
  "doctor"   { Invoke-Doctor }
  "run" {
    if ($Rest.Count -lt 1) { [Console]::Error.WriteLine("usage: oma-cast run <commandId>"); exit 2 }
    Invoke-Request @{ method = "run"; commandId = [string]$Rest[0] }
  }
  "call" {
    if ($Rest.Count -lt 1) { [Console]::Error.WriteLine("usage: oma-cast call <method> [json]"); exit 2 }
    $data = $null
    if ($Rest.Count -ge 2 -and $Rest[1]) { $data = [string]$Rest[1] | ConvertFrom-Json }
    Invoke-Request @{ method = "call"; data = @{ method = [string]$Rest[0]; data = $data } }
  }
  default {
    Write-Output "oma-cast - Raycast-style launcher for Windows"
    Write-Output "  oma-cast toggle | show | hide          show/hide the launcher (hotkey: Alt+Space)"
    Write-Output "  oma-cast run <commandId>              run a command directly"
    Write-Output "  oma-cast call <method> [json]         call a backend method"
    Write-Output "  oma-cast start                        launch the app"
    Write-Output "  oma-cast doctor                       check the installation"
    Write-Output "  oma-cast install                      PATH shim + autostart shortcut"
    exit 0
  }
}
