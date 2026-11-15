#!/bin/sh
# Forever Trades: download the newest prices into this addon folder (Mac). Then type /reload in the game.
cd "$(dirname "$0")" || exit 1
if curl -fsSL -o ForeverTrades_Data.lua.new "https://dargeron.github.io/forever-trades/data/ForeverTrades_Data.lua" \
   && [ "$(wc -c < ForeverTrades_Data.lua.new)" -gt 200 ]; then
  mv -f ForeverTrades_Data.lua.new ForeverTrades_Data.lua
  echo "Prices updated. In the game, type /reload"
else
  rm -f ForeverTrades_Data.lua.new
  echo "Could not download the prices; the old ones were kept."
fi
