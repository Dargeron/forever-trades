# Forever Trades: project memory

Static website plus an hourly GitHub Actions job for **WoW: Forever, EU PvP ruleset**. For the
chosen faction (Alliance or Horde) it shows what to **buy on the Blackwater (neutral) auction
house and sell at home**, and what to **buy at home and sell on Blackwater**, ranked and named,
with a return-vs-market-size chart and a budget shopping list. Hosted on GitHub Pages.
Full background, decisions and history: `docs/HANDOFF.md`.

## Layout
- `pipeline/update.py`: the whole pipeline, standard library only. `run` (default) and `probe`.
- `pipeline/config.json`: region `eu`, ruleset 1 (PvP), house ids 110/113/116, cuts. The fallback auto-matcher
  (`resolve_houses` / `match_scores`, used only if ids are null) needs a `pipeline/fingerprint.json`, which is
  deliberately not in the repo: the earlier one was a stored AHledger sample (their terms forbid keeping data), and
  it could not separate PvP from its look-alike group anyway. Re-verify ids with fresh in-game prices instead.
- `pipeline/items.json`: item id → [name, quality, class, subclass, randomSuffixGear]. Rebuild with `tools/build_items.py`.
- `pipeline/recipes.json`: every Classic Engineering recipe (skill, made per craft, reagents, trainer/schematic +
  source, Gnomish/Goblin), the 15 smelting recipes, vendor prices of vendor-sold reagents, bind-on-pickup products.
  Rebuild with `tools/build_recipes.py` (same wow-classic-items package; specialisation ids are hard-coded there).
- `site/`: `index.html`, `style.css`, `app.js` (vanilla JS, no dependencies; Cinzel from Google Fonts). Reads
  `site/data/latest.json`. WoW look: dark leather/gold (parchment in light mode), quality-coloured names, coin colours.
  Sections: ranked table, return-vs-market chart, ten biggest markets/returns, shopping list, busiest on Blackwater.
  Two tabs: "Auction trades" and "Engineering" (`#engineering`, loads `data/engineering.json` when opened).
- `.github/workflows/update.yml`: checks at :09/:29/:49 (Blizzard's hourly snapshot is stamped ~:25 but published 15–20+
  min later; a check with nothing new exits in seconds), plus push to main, plus manual. GitHub's schedule had never
  fired as of 14 Nov 2026, so an hourly Claude scheduled task in the owner's account starts the workflow by hand at
  :53 (force false) unless a scheduled run succeeded in the last 70 minutes. Restores and saves history on the
  `state` branch (force-pushed single commit), deploys Pages via artifact. `probe.yml`: manual house listing.
- `tools/selftest.py`: 9 simulated hours, offline. Run after any pipeline change.

## Running it
- Live site: https://dargeron.github.io/forever-trades/ (anyone with the link). Pages source: GitHub Actions.
- Secrets `BLIZZARD_CLIENT_ID` / `BLIZZARD_CLIENT_SECRET` are set in the repo's Actions secrets by the owner.
- GitHub pauses scheduled workflows in public repos after 60 days without activity. Don't add keep-alive tricks
  (GitHub disabled the best-known keep-alive action for breaking its terms); re-enable from the Actions tab.

## Commands
```bash
python3 tools/build_items.py
python3 tools/selftest.py
BLIZZARD_CLIENT_ID=… BLIZZARD_CLIENT_SECRET=… python3 pipeline/update.py run --state state --out site/data [--force]
python3 -m http.server -d site 8000
```

## Key facts
- Blizzard API: host `https://eu.api.blizzard.com`, namespaces `dynamic-forever-eu` / `static-forever-eu`, locale `en_GB`,
  OAuth client credentials at `https://oauth.battle.net/token`. Houses: `/data/wow/ruleset/1/auctions/` (trailing slash
  required), `/data/wow/ruleset/1/auctions/{id}` (`auctions` list + `commodities` link), `.../{id}/commodities`.
  15 houses (110–125, no 122), 5 per name ("Alliance/Horde/Blackwater Auction House"). Data is identical under every
  ruleset id and the ruleset mapping is NOT labelled. **EU PvP = Alliance 110, Horde 113, Blackwater 116**
  (verified 13 Nov 2026 by exact-price matching; pinned in config.json; look-alike group 111/114/117).
  Prices are copper. `Last-Modified` = snapshot time (about hourly); `If-Modified-Since` is ignored. Don't use
  `item.modifiers` (type 28) as a gear variant: it differs per listing. API shows listings only, never sales.
- Cuts: 5% on faction houses, 15% on Blackwater. Blackwater is shared by Booty Bay, Gadgetzan and Everlook; purchases arrive by mail.
- Sales are inferred by diffing hourly snapshots (see `diff_sales`). Cancellations can leak in, so treat as estimates.
- Thresholds: show if return ≥ ×1.15 and (after warming) profit ≥ 3s a day; "your share" = 25% of estimated daily
  sales where the buyers are; Solid ≥ ×2. Never cut a list to a top N (the owner missed items that way).
- **Home → Blackwater** (`to_blackwater`): sell = min(½ × other faction's cautious price, cheapest Blackwater listing);
  volume and "your share" come from the other faction's sales. Blackwater asks above that are ignored. Owner's rule:
  quantity caps come from Alliance/Horde sales, never Blackwater's. The ½ is `other_faction_share` in config.json.
- Sales estimates start after the first hourly diff (`EARLY_SALES_HOURS` = 1, flagged early on the site); below
  `MIN_SALES_HOURS` = 6 ("warming") every price gap is listed without a volume filter.
- `neutralTop` (`busiest`): items selling 0.5+/day on Blackwater that resell at a profit in a faction house
  (cautious price × 0.95 > Blackwater's cheapest listing NOW, or the average paid if none is listed; `basisNow`), by gold
  a day; `xA`/`xH`/`resellX` are those ratios. (Using the average paid showed ×1.19 next to a dearer Blackwater price.)
  Owner's rule: drop anything dearer on Blackwater than both houses pay (cross-character transfers);
  `hiddenItems`/`hiddenGold` count what was dropped.
- Site sorting: every column heading with `data-sort` sorts its table (again flips; arrow + `aria-sort`); the
  drop-down mirrors the ranked table. The chart has its own name filter (`#chart-search`, labels every match up to
  30); the owner wants the dots never to move, so axes and dot sizes always come from all items and the filter
  only hides dots. Dark theme is the default; parchment via the ☀ button (localStorage).
- **Versioned deploys**: GitHub Pages lets browsers cache the page/JS/CSS for 10 min while `latest.json` is always
  fetched fresh, so an old script once misread renamed fields (the Blackwater prices showed "–"). `update.yml` stamps
  `?v=<sha>` into index.html, `VERSION` into app.js, and the pipeline writes `siteVersion` (from GITHUB_SHA) into the
  data; a page whose VERSION differs reloads once to `?v=<siteVersion>`. Keep the `dev` placeholders in the source.
- Busiest table shows `low`/`aLow`/`hLow` = cheapest listing now (Blackwater empty when none); the resell ratios use
  the cautious `aRef`/`hRef`. Check layouts at 320–1440 px: the 9-column table drops columns at 1100/900/760/640.
- **Spike protection / price history** (owner's request after a ×488 Billy Club): `cautious(low, typ, paid, med)` =
  min of cheapest listing, 3-day hourly median market price (`series_median`, ≥3 points), 7-day typical and average
  paid (`avg_paid`). `diff_sales` treats a same-or-lower-price repost of the same quantity as a cancel. State keeps
  `series.json.gz` (per house: snapshot minutes `t` + per item `[low, mkt]` aligned, 72 h, ~3 MB gz when full) and
  `alltime.json.gz` (cheapest ever + date). The pipeline writes `site/data/series/<id>.json` for every listed item;
  the site loads it when an item is opened (graph + table). No backfill exists: history starts 13 Nov 2026.
- Every item is clickable everywhere: table rows expand (`expandable`), chart dots and tile names open a card
  (`openModal`). Details panels are built on first open, so no history file loads with the page.
- Money display: g/s/c; coppers only under 10s; 10s and up rounded to silver; 100g+ shows gold only.
- **Engineering** (`material_costs` / `engineering` in update.py, owner's request, skill 220 by default): per recipe and
  faction, one craft's materials at the cheapest of: buying in that house (`walk` up the listings for the amount;
  median/typical if none listed, marked `recent`), the vendor price, or making it (smelting/engineering parts,
  recursively, no cycles). Sell = cautious price in that house (kept to 2 decimals: ammo is a few copper, 200 a
  craft); profit per craft = n × sell × 0.95 − cost; profit a day = profit / n × 25% of sold a day. BoP products
  are left out; Mining skill for smelting is assumed. Rows carry the full material tree (`parts`, nodes `i, qty,
  how, c, ah, v, mk, p...`); names of materials are in `names`. The site filters by skill/schematic/specialisation.
- Chart "Across" switch: market a day (default, the owner's original spec) or sale price; remembered. Dot size = sale
  price of one item (owner's request), log-scaled across all chart items (10c to 750g on live data), with a size key;
  drawn biggest first so small dots stay on top. The owner once
  read market a day as price (a 2g pattern selling 21/day sat right of a 5g one selling 5/day).
- Never move gold between factions (Blizzard forbids it on Classic versions). Trade goods only. The site says so.

## Conventions
- Keep the pipeline standard-library only; keep the site dependency-free; insert names with `textContent`.
- Credit: "Prices from Blizzard's Battle.net API"; item names from wow-classic-items (MIT). Not affiliated with Blizzard.
- No secrets in the repo: `BLIZZARD_CLIENT_ID` / `BLIZZARD_CLIENT_SECRET` live in GitHub Actions secrets.
- The repo is public (free GitHub Pages), so keep personal details out of committed files.
