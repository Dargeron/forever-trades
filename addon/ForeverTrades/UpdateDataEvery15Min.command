#!/bin/sh
# Forever Trades (Mac): leave this window open while you play. Every 15 minutes it downloads the newest prices
# into this addon folder; in the game, type /reload whenever you want the addon to use them.
cd "$(dirname "$0")" || exit 1
while true; do
  if curl -fsSL -o ForeverTrades_Data.lua.new "https://dargeron.github.io/forever-trades/data/ForeverTrades_Data.lua" \
     && [ "$(wc -c < ForeverTrades_Data.lua.new)" -gt 200 ]; then
    mv -f ForeverTrades_Data.lua.new ForeverTrades_Data.lua
    echo "$(date +%H:%M) Prices updated. In the game, type /reload"
  else
    rm -f ForeverTrades_Data.lua.new
    echo "$(date +%H:%M) Could not download the prices; the old ones were kept."
  fi
  sleep 900
done
