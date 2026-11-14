# Forever Trades

A small website for **WoW: Forever, EU PvP** that shows, for Alliance or Horde:

- **Buy on Blackwater → sell at home**: items that are cheaper on the neutral
  (Blackwater) auction house than they sell for in your faction's house, after
  the 5% cut.
- **Buy at home → sell on Blackwater**: items that are cheap at home and dear in
  the other faction's house, priced for the other faction's traders who buy on
  Blackwater and resell at home (see Numbers), after Blackwater's 15% cut.

Every opportunity is ranked and named in a table (tap any column heading to sort),
with a return-vs-market-size chart (with a name filter, e.g. "recipe"), the ten biggest markets and returns, a shopping
list for a chosen budget, and the busiest items on Blackwater that can be resold at
a profit in the Alliance or Horde house.

An **Engineering** tab (`#engineering`) works out, for every Engineering recipe, what one craft's
materials cost the cheapest way (buy in your faction's house, buy from a vendor, or smelt ore and make
the parts yourself) against what the item sells for there after the 5% cut, filtered by your skill
(220 by default), schematics and Gnomish/Goblin specialisation.

## How it updates

`.github/workflows/update.yml` runs every hour on GitHub Actions (free for public
repositories):

1. Reads the EU PvP Alliance, Horde and Blackwater auction houses from Blizzard's
   Battle.net API (`dynamic-forever-eu`).
2. Compares each house with its previous snapshot to estimate what sold (the API
   only lists what is for sale). Listings that vanish with 2+ hours left count as
   sold, unless they look like a cancel-and-relist or a cheaper old listing of the
   same item is still up.
3. Keeps 14 days of history on the `state` branch (overwritten each hour, so the
   repository stays small).
4. Writes `site/data/latest.json` and `site/data/engineering.json` and publishes `site/` to GitHub Pages.

If Blizzard has not published a new snapshot, the run stops early and nothing is
redeployed.

## Setup

1. Repository secrets (Settings → Secrets and variables → Actions):
   `BLIZZARD_CLIENT_ID`, `BLIZZARD_CLIENT_SECRET` (from https://develop.battle.net).
2. Settings → Pages → Source: **GitHub Actions**.
3. Blizzard's API does not label which auction house belongs to which ruleset. The EU PvP
   houses are pinned in `pipeline/config.json`: Alliance 110, Horde 113, Blackwater 116
   (verified 13 Nov 2026 by matching exact prices against in-game scans; the look-alike group
   is 111/114/117). The **Probe auction houses** workflow lists every house with a price sample,
   if they ever need re-checking.

Run **Update prices** from the Actions tab at any time to refresh by hand.

## Tests

```bash
python3 tools/build_items.py   # rebuilds pipeline/items.json from the wow-classic-items npm package
python3 tools/build_recipes.py # rebuilds pipeline/recipes.json (Engineering + smelting recipes, vendor prices)
python3 tools/selftest.py      # 9 simulated hours through the pipeline, no network needed
```

## Local run

```bash
export BLIZZARD_CLIENT_ID=... BLIZZARD_CLIENT_SECRET=...
python3 pipeline/update.py run --state state --out site/data
python3 -m http.server -d site 8000
```

Only the Python standard library is used.

## Numbers

- **Buy at**: average price for the suggested amount, walking up from the cheapest listing.
- **Sell at, selling at home**: the cheaper of the current lowest listing and the 7-day typical price in your house.
- **Sell at, selling on Blackwater**: half the other faction's price (`other_faction_share` in
  `pipeline/config.json`), so their traders can still resell at a profit; or the cheapest Blackwater
  listing if that is lower (competition). Blackwater's own asking prices are otherwise ignored: they are
  often stale and far too high.
- **Spike protection**: every planning price is the lowest of the cheapest listing now, the item's
  3-day median market price (hourly, from `state/series.json.gz`, once 3 points exist), its 7-day
  typical price and the average price buyers actually paid. A few silly listings left after the
  reasonable copies sold can't set the price. A cancel-and-repost at the same price is not a sale.
- **Price history**: open any item for an hourly graph of its cheapest price in each house (72 h),
  the 3-day median, the cheapest of 7 days and since tracking began (13 Nov 2026), and what buyers
  paid. History cannot be backfilled: Blizzard only serves the current snapshot, and other sites'
  terms forbid storing their data. One small `data/series/<id>.json` per listed item.
- **Return (×)**: (sell × (1 − cut)) ÷ buy. Shown when ≥ ×1.15.
- **Sold a day**: estimated where the buyers are: your house (Blackwater → home) or the other faction's
  house (home → Blackwater). Blackwater's own thin sales never set a quantity.
- **Your share**: a quarter of that, so you don't flood the market.
- **Early data**: sales figures appear after the first hourly comparison and are marked early. For the
  first 6 hours every price gap is listed; after that only items selling at least 0.5 a day. Lists are
  never cut to a top N.
- **Busiest on Blackwater**: items seen selling there (0.5+ a day) that can be resold at a profit in the
  Alliance or Horde house: that house's cautious price × 0.95 must beat the average price paid on
  Blackwater. "Resell in" shows the house and that ratio. Items dearer on Blackwater than both houses pay
  are left out (mostly players moving goods between their own characters); the site states how many and
  how much gold a day they were.
- **Engineering**: materials per craft = for each reagent, the cheapest of its auction-house price
  (walking up the listings for the amount needed; its recent median if none is listed), its vendor price,
  or making it (smelting, engineering parts), recursively. Sells for = the item's cautious price in your
  house; profit per craft = made per craft × that × 0.95 − materials. Bind-on-pickup products are left
  out. Smelting assumes the Mining skill. Recipes come from wow-classic-items (Classic data).
- **Chart, across**: market a day (default) or the sale price of one item. Market a day = sold a day ×
  price, so a cheap item that sells often sits right of a dear one that rarely sells.
- Deposits are not included.

## Credits

Prices: Blizzard Battle.net API. Item names and recipes: [wow-classic-items](https://github.com/Nakroma/wow-classic-items)
(MIT, © Nakroma) plus Blizzard's item API. Not affiliated with or endorsed by Blizzard Entertainment.
World of Warcraft and Blizzard Entertainment are trademarks of Blizzard Entertainment, Inc.
