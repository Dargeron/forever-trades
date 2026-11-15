FOREVER TRADES - in-game addon for WoW: Forever
================================================

What it does
  When you open an auction house, a window next to it shows the cross-faction trades from the
  Forever Trades website (https://dargeron.github.io/forever-trades/), from where you stand:

  At Blackwater (Booty Bay, Gadgetzan, Everlook):
    - Buy here now, sell in your faction's house
    - Buy in your faction's house, sell here
  At your faction's house:
    - Buy here now, sell on Blackwater
    - Buy on Blackwater, sell here

  It reads your own listings when the auction house opens, and remembers them for each house, so the
  lists leave out everything you are already selling (untick the box to see them again, marked).
  Items you already carry are marked "in your bags". Click an item to search for it; shift-click to
  link it in chat.

Install
  1. Unzip so that this folder sits in your WoW: Forever folder under
     Interface\AddOns\ForeverTrades  (the folder must be called ForeverTrades).
  2. Start the game. If the addon list says it is out of date, tick "Load out of date AddOns".

Keeping the prices fresh
  The game doesn't let addons go online, so the prices live in ForeverTrades_Data.lua in this
  folder. The website rewrites it every hour. To get the newest one:
    - Windows: double-click UpdateData.bat     - Mac: double-click UpdateData.command
  then type /reload in the game. The window says how old its prices are.

Commands
  /ft             open or close the window anywhere (shows your faction's house)
  /ft blackwater  open it with the Blackwater lists
  /ft reset       forget stored listings, house choices and the window position

If the window names the wrong auction house (it goes by the zone name), use the two buttons at the
top to say which house you're at; it remembers that for the zone.

A fan-made tool, not affiliated with or endorsed by Blizzard Entertainment.
