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

  Live prices: when the auction house opens, it also checks what every item on the lists costs there
  right now (one full read of the house, which the game allows once every 15 minutes, or else one search
  per item) and re-prices the trades with it: what you'd pay here, or the competition you'd sell against
  here. Trades that no longer pay at today's prices move to the bottom, greyed out. "Check again" re-reads
  the house. The other house's prices and the sales figures still come from the website's file.

Install
  1. Unzip so that this folder sits in your WoW: Forever folder under
     Interface\AddOns\ForeverTrades  (the folder must be called ForeverTrades).
  2. Start the game. If the addon list says it is out of date, tick "Load out of date AddOns".

Keeping the website's prices fresh
  The game doesn't let addons go online, so the website's prices live in ForeverTrades_Data.lua in
  this folder. The website rewrites it every hour; the game reads it when you log in or type /reload.
  To get the newest one:
    - once:              double-click UpdateData.bat (Windows) or UpdateData.command (Mac)
    - while you play:    double-click UpdateDataEvery15Min.bat / .command and leave its window open
  then type /reload in the game when you want the addon to use the new file. The window says how old
  the website's prices are.

Commands
  /ft             open or close the window anywhere (shows your faction's house)
  /ft blackwater  open it with the Blackwater lists
  /ft scan        check the live prices at this auction house again
  /ft reset       forget stored listings, house choices and the window position

If the window names the wrong auction house (it goes by the zone name), use the two buttons at the
top to say which house you're at; it remembers that for the zone.

A fan-made tool, not affiliated with or endorsed by Blizzard Entertainment.
