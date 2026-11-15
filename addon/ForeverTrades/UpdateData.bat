@echo off
rem Forever Trades: download the newest prices into this addon folder. Then type /reload in the game.
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -Command ^
  "try { Invoke-WebRequest -UseBasicParsing -Uri 'https://dargeron.github.io/forever-trades/data/ForeverTrades_Data.lua' -OutFile 'ForeverTrades_Data.lua.new';" ^
  "  if ((Get-Item 'ForeverTrades_Data.lua.new').Length -gt 200) { Move-Item -Force 'ForeverTrades_Data.lua.new' 'ForeverTrades_Data.lua'; Write-Host 'Prices updated. In the game, type /reload' }" ^
  "  else { Remove-Item 'ForeverTrades_Data.lua.new'; Write-Host 'The download looks wrong; the old prices were kept.' } }" ^
  "catch { Write-Host ('Could not download the prices: ' + $_.Exception.Message) }"
pause
