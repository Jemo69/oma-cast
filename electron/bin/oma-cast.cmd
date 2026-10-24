@echo off
rem oma-cast CLI shim (keep next to oma-cast.ps1).
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0oma-cast.ps1" %*
