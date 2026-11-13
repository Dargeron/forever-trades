# Forever Trades

A small website for **WoW: Forever, EU PvP** that shows, for Alliance or Horde:

- **Buy on Blackwater → sell at home**: items that are cheaper on the neutral
  (Blackwater) auction house than they sell for in your faction's house, after
  the 5% cut.
- **Buy at home → sell on Blackwater**: the reverse, after Blackwater's 15% cut.

Every opportunity is ranked and named, with a return-vs-market-size chart and a
shopping list for a chosen budget.

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
4. Writes `site/data/latest.json` and publishes `site/` to GitHub Pages.

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
- **Sell at**: the cheaper of the current lowest listing and the 7-day typical price on the house you sell on.
- **Return (×)**: (sell × (1 − cut)) ÷ buy. Shown when ≥ ×1.15.
- **Your share**: a quarter of the estimated daily sales, so you don't flood the market.
- Deposits are not included.

## Credits

Prices: Blizzard Battle.net API. Item names: [wow-classic-items](https://github.com/Nakroma/wow-classic-items)
(MIT, © Nakroma) plus Blizzard's item API. Not affiliated with or endorsed by Blizzard Entertainment.
World of Warcraft and Blizzard Entertainment are trademarks of Blizzard Entertainment, Inc.
