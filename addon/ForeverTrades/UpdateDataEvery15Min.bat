@echo off
rem Forever Trades: leave this window open while you play. Every 15 minutes it downloads the newest prices
rem into this addon folder; in the game, type /reload whenever you want the addon to use them.
cd /d "%~dp0"
title Forever Trades prices (close this window to stop)
:loop
powershell -NoProfile -ExecutionPolicy Bypass -Command "try { Invoke-WebRequest -UseBasicParsing -Uri 'https://dargeron.github.io/forever-trades/data/ForeverTrades_Data.lua' -OutFile 'ForeverTrades_Data.lua.new'; if ((Get-Item 'ForeverTrades_Data.lua.new').Length -gt 200) { Move-Item -Force 'ForeverTrades_Data.lua.new' 'ForeverTrades_Data.lua'; Write-Host ((Get-Date -Format 'HH:mm') + ' Prices updated. In the game, type /reload') } else { Remove-Item 'ForeverTrades_Data.lua.new'; Write-Host 'The download looks wrong; the old prices were kept.' } } catch { Write-Host ('Could not download the prices: ' + $_.Exception.Message) }"
timeout /t 900 /nobreak >nul
goto loop
