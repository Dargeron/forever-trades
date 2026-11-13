# Forever Trades: handoff to Claude Code

The background record of the project: what we're building and why, everything learned so far,
and the state at handoff. It was written by the Claude session (Cowork) that designed, built and
tested the project. That session could not reach GitHub, so the source code travelled inside this
file (a former section 12) and was unpacked into this repository by Claude Code on 13 Nov 2026.

This public copy leaves out the embedded source (it is now the repository itself) and personal
details about the owner. What changed at import is in section 12.

---

## 1. Instructions for Claude Code (do these in order)

1. **Unpack the files.** From the repository root run:

   ```bash
   python3 - <<'PY'
   import hashlib, os, re
   text = open('HANDOFF.md', encoding='utf-8').read()
   pat = re.compile(r'<!-- FILE: (?P<path>[^ ]+) sha256=(?P<sha>[0-9a-f]{64}) -->\n~{8}[^\n]*\n(?P<body>.*?)\n~{8}\n<!-- END FILE -->', re.S)
   n = 0
   for m in pat.finditer(text):
       body = m['body'] + '\n'
       assert hashlib.sha256(body.encode()).hexdigest() == m['sha'], 'checksum mismatch: ' + m['path']
       os.makedirs(os.path.dirname(m['path']) or '.', exist_ok=True)
       open(m['path'], 'w', encoding='utf-8').write(body)
       n += 1
       print('wrote', m['path'])
   print(n, 'files unpacked, all checksums OK')
   PY
   ```

   It should write 14 files. If a checksum fails, the file was altered in transit. Re-download it.
   Don't hand-copy the code.

2. **Build the item names:** `python3 tools/build_items.py`. It downloads the MIT npm package
   `wow-classic-items` from registry.npmjs.org and writes `pipeline/items.json` (about 38,350
   items, 2 MB). If your network blocks npm, tell the user. The pipeline still works without it
   (names then come from Blizzard's item API, which misses ~40% of Classic items), but
   random-suffix gear filtering gets weaker.

3. **Run the offline test:** `python3 tools/selftest.py` (takes 1–5 minutes). It must end with `selftest OK`.
   Optionally preview the site: copy `/tmp/ft-selftest/out/latest.json` to `site/data/latest.json`,
   run `python3 -m http.server -d site 8000`, and look at it at phone width (390 px) and desktop
   width, in light and dark mode. Then delete `site/data/` (it's git-ignored anyway).

4. **Move this file** to `docs/HANDOFF.md` (keep it: it's the background record) and **commit and
   push to `main`**. `CLAUDE.md` (unpacked in step 1) is the short project memory for future sessions.

5. **GitHub settings.** The user must do these, unless you have API access with enough rights:
   - **Settings → Secrets and variables → Actions → New repository secret**: `BLIZZARD_CLIENT_ID`
     and `BLIZZARD_CLIENT_SECRET`. The user creates these at https://develop.battle.net →
     API Access → Create Client: any name, no redirect URL, tick "I do not have a service URL",
     intended use "personal auction house price tool". Never put these values in a file or a commit.
   - **Settings → Pages → Build and deployment → Source: GitHub Actions.**
   - **Settings → Actions → General**: Actions allowed. If a push from the workflow is refused,
     set **Workflow permissions** to **Read and write**.
   - The repository must be **public** for free GitHub Pages.

6. **First live run:** Actions tab → **Update prices** → **Run workflow**. The pipeline was
   already run against the live API from the building session on 13 Nov 2026 (section 6), so
   no surprises are expected. In the log, check:
   - Three lines like `alliance: ~230000 auctions …`, `horde: ~265000 auctions …` and
     `neutral: ~34000 auctions …`. The EU PvP house ids are pinned in `pipeline/config.json`:
     Alliance **110**, Horde **113**, Blackwater **116**. See section 6 for how they were found.
   - `changed=true`, the deploy job runs, and the `state` branch appears.
   - If the user reports that prices on the site don't match the game, re-check the house ids.
     Two big look-alike groups exist (110/113/116 and 111/114/117).

7. **Check the live site** at `https://<user>.github.io/<repo>/`. For the first ~6 hours it shows
   a "Still learning what sells" banner (price gaps only). After that, sales figures, the chart and
   the shopping list appear. Give the user the link. Check again after a few hourly runs: the
   `state` branch should update, and a run with no new Blizzard snapshot should end with
   "Nothing new from Blizzard; skipping" without deploying.

8. Tell the user, in plain words: the site URL, that it updates itself every hour, that "sells a day"
   needs about a day to settle and the 7-day typical price about a week, and how to refresh by hand
   (Actions → Update prices → Run workflow).

---

## 2. Audience and working style

- Built for players on the WoW: Forever **EU PvP ruleset**, Alliance or Horde. At one point the
  Horde side was locked for new characters ("This faction is currently unavailable on this ruleset
  due to population imbalance").
- The site is mostly read on a phone. Answers to the owner should be full and detailed anyway.
- The owner is not a developer: explain setup steps click by click. Things should run by themselves.
- Explicit choices for this project:
  - Automatic and **free**, via GitHub Actions.
  - Hosted on **GitHub Pages** (the user first mentioned Cloudflare, then chose GitHub Pages).
  - **Anyone with the link** can view it.
  - **EU PvP only**: not the other rulesets or regions.
- The website replaces an earlier one-off "neutral-to-Alliance" PDF buy list with a live,
  both-factions, both-directions version.

## 3. What the user asked for (requirements)

> "Turn this pdf into a website that can be updated every day … Make the website easy to understand.
> You can select Alliance or Horde, and it will tell you what to sell on the Neutral AH and what to
> buy to resell in your faction AH. It will show the graph with the best items (naming all of them,
> not just a few) and show the top items etc. And it will be easy to update it when I ask you to
> recheck the current prices, or if we set a scheduled task."

What that became:
- Faction switch: Alliance / Horde (remembered per browser).
- Two directions: **Buy on Blackwater → sell at home** and **Buy at home → sell on Blackwater**.
- **Every** qualifying item ranked and **named**: a bar list showing the top 40 by default, with
  "Show all N items" and a search box. The user complained once when a good item, Elixir of Giant
  Growth, was missing from a PDF top list. Never silently cut items: show them all, or say how
  many are hidden and offer the rest.
- A "return vs market size" scatter, the same idea as the PDF chart, with selective direct labels
  and a tap tooltip for every dot.
- Summary tiles, a budget shopping list (5–100g) with "copy list", and a plain-language "How to read this".
- Updates by itself hourly. Manual refresh from the Actions tab.

## 4. Decisions and why

- **Data source: Blizzard's official Battle.net API**, the user's own free client.
  - It covers all three houses, *including the neutral Blackwater house*.
  - It's official, and there are no third-party licence limits.
  - Rejected alternatives:
    - **AHledger:** it has an API at `api.ahledger.com/v1/pricetable/forever.pvp.alliance.eu`, but
      it doesn't cover the neutral house. Its terms say: credit required; from 10 Dec 2026, 30
      requests/min without a key; don't keep answers past their Cache-Control time; no resale as a
      feed. Its site blocks headless browsers (Vercel checkpoint), and robots.txt disallowed the API
      for the earlier Claude fetcher.
    - **forevermastery.com:** robots allows the pages, but scraping it to republish on a public
      site is the wrong basis.
- **Hosting: GitHub Pages + GitHub Actions.** Free, and the user's choice.
  - Cloudflare Workers Free was ruled out: its 10 ms CPU limit can't parse ~10 MB house dumps.
    Workers Paid would cost $5/month.
  - A Claude scheduled task was ruled out: it costs usage, keeps no hourly history, and can't
    reach the user's GitHub.
- **History on a `state` branch**, force-pushed as a single commit each hour, so the repo doesn't grow.
  - It holds: the previous snapshot per house (gzipped), 14 days of per-item daily aggregates, the
    house ids found, and the item-name cache.
- **Sales are inferred** by diffing hourly snapshots, because the API never reports sales.
  "Sold a day" needs 6+ hours of data. Until then the site runs in "warming" mode: price gaps
  only, sorted by profit per item, capped at 80 items, with a banner.
- **House ids are pinned in `config.json`:** Alliance 110, Horde 113, Blackwater 116. They were
  verified on 13 Nov 2026 (section 6). Blizzard doesn't label which of the 5 same-named houses
  is PvP. The pipeline still has an automatic fingerprint matcher (`resolve_houses` /
  `match_scores`), used only if the config ids are set to null. **Don't rely on it blindly:**
  on 13 Nov it could not separate the PvP group from its look-alike (see section 6).
- **The pipeline uses only the Python standard library**, and the **site has no dependencies**
  (vanilla JS, SVG drawn by hand). Fewer things can break.

## 5. Architecture

```
GitHub Actions (hourly :17, push to main, manual)
  └─ build job
      ├─ restore state/ from branch `state` (if it exists)
      ├─ python3 pipeline/update.py run --state state --out site/data [--force]
      │    ├─ OAuth token → list houses → match EU PvP ids (first run only)
      │    ├─ for each house: GET auctions (+ commodities) with If-Modified-Since
      │    ├─ diff against previous snapshot → sales estimate → update 14-day history
      │    ├─ summarise (lowest, 15th-percentile price, quantity, price ladder)
      │    ├─ opportunities for alliance/horde × two directions
      │    └─ write site/data/latest.json; prints changed=true/false to GITHUB_OUTPUT
      ├─ if changed: force-push state/ to branch `state`
      └─ if changed: upload site/ as the Pages artifact
  └─ deploy job (only if changed) → actions/deploy-pages
```

`latest.json` shape:
- `generated`, `region`, `ruleset`, `houseIds`.
- `houses.{alliance,horde,neutral}`: `{snapshot, auctions, items, salesHours}`.
- `factions.{alliance,horde}.{buyNeutralSellHome,buyHomeSellNeutral}`: `{warming, salesHours, items: [...]}`.

Each item carries:
- **Identity:** `id`, `name`, `q` (quality), `cls`, `sub`.
- **Buy side:** `buy`, `low`, `srcQty`, `srcTyp`.
- **Sell side:** `sell`, `back`, `dstQty`, `dstLow`, `dstTyp`.
- **Volume and profit:** `soldDay`, `unitsDay`, `mult`, `profitEach`, `profitDay`, `marketDay`, `daysStock`.
- **Labels:** `tag` (Solid/Fair), `trend` (falling/rising/null).
- **Order book:** `ladder` ([price, qty] levels on the buy side, used by the shopping list).

All money is in copper.

## 6. Blizzard API for WoW: Forever: what we know

Sources: community reports from 5–10 Nov 2026 (Blizzard forum thread "WoW: Forever API: what works
so far", SideQuest-Guild/wow-forever-sdk PR #2, Everloot PR #867, forever-build-coach PR #10,
AidVir/wow-forever-favor). Nothing is officially documented yet.

- **Auth:** `POST https://oauth.battle.net/token`, `grant_type=client_credentials`, HTTP Basic with
  the client id and secret. No special scope.
- **Namespaces:** `dynamic-forever-eu` (rulesets, auctions), `static-forever-eu` (items),
  `profile-forever-eu`. Locale `en_GB` (as used by AidVir).
- **Rulesets:** `/data/wow/ruleset/index` gives ids **1 PvP, 2 Normal, 3 Roleplay, 15 Roleplay PvP** (EU and US).
- **Auction index:** `/data/wow/ruleset/{id}/auctions/`. The **trailing slash is required**; without
  it you get a 404. It returns `{auctions: [{key, name, id}]}`.
- **Houses** (verified live, 13 Nov 2026): 15 houses, ids **110–121 and 123–125** (no 122). Five
  each named "Alliance Auction House", "Horde Auction House" and "Blackwater Auction House". The
  **same data comes back under every ruleset id**, so don't add totals across rulesets. The
  house ↔ ruleset mapping is **not labelled**. The ids form groups: Alliance 110/111/112/119/123,
  Horde 113/114/115/120/124, Blackwater 116/117/118/121/125.
  - **Two big groups:** 110/113/116 and 111/114/117, each ~230–265k auctions per faction house.
  - **112/115/118** are empty.
  - **Two small groups:** 119/120/121 and 123/124/125, ~20–37k faction auctions and ~1k Blackwater.
  - **EU PvP = Alliance 110, Horde 113, Blackwater 116.** How this was found: listings with only
    1–4 units that sat at exactly the same price as in our 12 Nov EU PvP scans.
    - House 110 matched 14.0% of 1,180 rare Alliance listings (house 111: 5.3%), and its median
      price error was 0.135 vs 0.176.
    - House 116 matched 15.4% of 1,628 rare Blackwater listings (house 117: 7.7%), with a price
      error of 0.216 vs 0.400.
    - Horde was a tie with our older (48 h) Horde scan; 113 follows the group pattern (offset 0)
      and scored better on the 52-item fingerprint.
    - The automatic 52-item fingerprint alone picked 111/113/117, with every match flagged
      "close". So the fingerprint is not enough to tell the two big groups apart. If ids ever need
      re-checking, compare rare exact-price listings against a fresh in-game check, and keep
      Alliance/Horde/Blackwater from the same offset group.
- **Per house:** `/data/wow/ruleset/{id}/auctions/{houseId}` returns `{id, name, auctions, commodities, ruleset}`.
  - Commodities: `/data/wow/ruleset/{id}/auctions/{houseId}/commodities` returns
    `{auctions: [{id, item:{id}, quantity, unit_price, time_left}]}`.
  - Auctions: `{id, item:{id, context, bonus_lists, modifiers}, buyout, bid?, quantity, time_left}`.
    `buyout` is for the whole stack. Bid-only auctions have no buyout and are skipped.
- **Verified live on 13 Nov 2026:**
  - Prices are in **copper**. At 15:25 UTC on house 110: Linen Cloth 25, Silk Cloth 190,
    Mithril Bar 1042, Runecloth 1060.
  - `time_left` is SHORT / MEDIUM / LONG / VERY_LONG. House 110 had 77k LONG, 16k MEDIUM,
    15k VERY_LONG and 4k SHORT.
  - The house response holds `auctions` as a list (~112k non-stackable listings on house 110)
    and `commodities` as a **link** (`{href}`) to the commodities endpoint (~105k listings).
  - `Last-Modified` is present (snapshot time, about hourly). `Cache-Control: public, max-age=86400`.
  - **`If-Modified-Since` is ignored** (always 200). The pipeline compares `Last-Modified` with
    the stored value instead, so an unchanged snapshot still downloads (~20 MB per faction
    house), then skips.
  - Gear: `item.bonus_lists` carries the random suffix (e.g. [12718] … [12733]). `item.modifiers`
    (type 28) **varies per listing even on non-random gear**, so it must not be used as a variant
    key (fixed in `fetch_house`). About 12 of 112k listings are bid-only.
  - A full run (3 houses + commodities + up to 300 item-name lookups) takes about 1.5 minutes.
- **Size:** faction houses ~230–265k listings in total (about 10 MB + 9 MB gzip-decoded JSON);
  Blackwater ~34k.
- **Item names:** `/data/wow/item/{id}?namespace=static-forever-eu`. About 43% of Classic-era item
  ids return 404, which is why `items.json` exists. Forever-only items do resolve.
- **Refresh:** a new snapshot about once an hour.
- **Rate limits:** 36,000/hour and 100/second. We use about 6–10 calls an hour, plus up to 150
  item lookups per run for new ids.

## 7. Algorithms (as implemented in `pipeline/update.py`)

- **Per-item summary:** lowest unit price; "market" price = unit price at the 15th percentile of
  listed units, so a single cheap stack can't fool it; total quantity; price ladder (up to 40
  levels); number of distinct variants (bonus lists, rand), used to drop random-suffix gear.
- **Sales estimate (`diff_sales`)**, between consecutive snapshots with a gap of 0–12 hours:
  - A **partial decrease** in a stack is a sale.
  - A listing that **disappears** with LONG/VERY_LONG time left (VERY_LONG only if the gap is
    over 2.2 hours) counts as sold, **unless**:
    - (a) a new listing of the same item and same quantity appeared at a lower price, which is a
      cancel-and-undercut; or
    - (b) an older listing of the same item that is still up is cheaper. Buyers take the cheapest
      stack first, so the dearer one was most likely cancelled.
- **History:** per house, per item, per UTC day: `[sold_units, sold_copper, mkt_sum, mkt_n, low_min, qty_sum]`.
  Per day it also stores the hours covered. Days older than 14 are pruned.
  - `soldDay` = units sold over the last 7 days ÷ hours covered × 24. It's null below 6 hours.
  - `dstTyp` ("7-day typical") = median of the daily average market price, once there are 2 or
    more days with 3 or more samples.
- **Opportunity (source house → destination house, cut c = 5% at home, 15% on Blackwater):**
  - `sell` = min(destination lowest, destination 7-day typical); falls back to typical if nothing is listed.
  - `back = sell × (1 − c)`.
  - `unitsDay` = min(25% of destination `soldDay`, source quantity). Skipped if `soldDay` < 0.5.
  - `buy` = average cost of walking the source ladder for ceil(`unitsDay`) units.
  - `mult = back / buy`. Kept if ≥ 1.15 and `profitDay` ≥ 3s.
  - `tag` is Solid at ×2 or more, otherwise Fair. `trend` is "falling" if destination lowest < 0.6 × typical, "rising" if > 1.5 ×.
  - Random-suffix gear is excluded: `items.json` flag, or Armor/Weapon with more than one variant.
  - Sorted by `profitDay`. In warming mode, by `profitEach`, top 80.
- **Shopping list (client side):**
  - Only items selling at least once a day are considered, best return first.
  - Each gets up to floor(`unitsDay`) units, or 1 if it sells twice a day or more.
  - Walk the ladder while `back / price` ≥ 1.15 and budget remains.
  - Drop lines worth under 3s.
- These mirror the conventions of the earlier PDFs:
  - "Cautious sell" = min(lowest, median, 7-day median).
  - Faction cut 5%, neutral cut 15%.
  - "Solid" ×2+, "Fair" ×1.15+.
  - Take about a quarter of daily sales.

## 8. Website (`site/`)

- **Style:** light and dark mode follow the device. Tokens are CSS variables (surfaces
  `#fcfcfb` / `#1a1a19`, bar blue `#2a78d6` / `#3987e5`). Status yellow is used only with a
  "▼ price falling" label.
- **Layout:** works at 390 px with no horizontal scroll. The control bar is sticky on desktop only.
- **Sections:**
  - Header and freshness line ("Prices from Blizzard's snapshot of 15:00 (14:00 UTC), 23 min ago").
  - Faction and direction switches.
  - One explanation sentence, plus a banner (warming / early estimates).
  - 3 tiles: total profit a day if you work the whole list, best item a day, best return.
  - Ranked bar list (rank by profit a day / return / market size / profit per item; search; tap
    for 12 details and a "Today: buy up to N … list at …" line).
  - Scatter (log-log; direct labels for the top 8 on mobile, 16 on desktop, skipping collisions;
    24 px hit targets).
  - Shopping list, "How to read this", footer credits.
- **Safety:** item names are inserted with `textContent` only. localStorage (faction, direction,
  budget) is wrapped in try/catch.
- **Freshness:** re-fetches `data/latest.json` when the tab returns after 10+ minutes. The
  freshness line updates every minute.
- **Tested:** with Playwright at iPhone 13 and 1200 px, light and dark. No console errors, no
  horizontal overflow.

## 9. Status

- **Done:** pipeline, site, workflows, house auto-matching, item-name builder and offline self-test.
- **Tested:** all of it on simulated data, including 340k-auction houses (about 6 s per run), the
  cancel/relist/partial-buy cases, warming mode, unchanged-snapshot runs and decoy-house matching.
- **Run live:** on 13 Nov 2026 the pipeline ran against the live API (with the owner's Blizzard
  client). It worked first time: real `latest.json` in warming mode. House ids were
  verified and pinned.
- **Not done:** publishing to GitHub. The building session's network proxy only allows GitHub
  repositories attached to that session, and the user's repo couldn't be attached, which is why
  this handoff exists.
- **Waiting on the user:** the GitHub secrets (`BLIZZARD_CLIENT_ID` / `BLIZZARD_CLIENT_SECRET`)
  and the Pages source. Never write the secret values into the repo.

## 10. Risks, open questions, next ideas

- **House ids:** if Blizzard ever renumbers houses, the site will silently show another
  ruleset's prices. If the user reports a mismatch, re-verify (section 6).
- **Sales estimates:** cancellations still leak in. Blackwater asks are often stale (in Nov 2026,
  neutral Mithril Bar was listed at 22s against 9s on both faction houses), so "buy at home → sell
  on Blackwater" depends on real neutral sales. Never on asking prices alone.
- **GitHub schedule:** hourly runs can be delayed. In public repos, scheduled workflows are
  disabled after 60 days without repository activity. Check whether the hourly `state` pushes
  count. If not, add a keep-alive, or tell the user how to re-enable.
- **Action versions:** bumped at import to `actions/checkout@v7`, `upload-pages-artifact@v5`,
  `deploy-pages@v5` (Node 24); `probe.yml` uses `upload-artifact@v7`. Bump again if GitHub deprecates them.
- **Not modelled:** auction deposits (higher on Blackwater), mail and travel time.
- **Ideas the user may like later:**
  - An Alliance ↔ Horde view through Blackwater.
  - A crafting-profit view (e.g. Engineering and Tailoring).
  - Price history sparklines per item.
  - Discord or phone alerts for ×3+ deals.
  - A "last 24 h" sales column.

## 11. Background game knowledge (from the earlier analysis)

- **The game:** WoW: Forever is a realmless Classic-based game that launched **4 Nov 2026**.
  Rulesets: Normal, PvP, RP, RP-PvP. Each region × ruleset has its own Alliance and Horde
  house, plus the neutral **Blackwater** house shared by **Booty Bay, Gadgetzan and Everlook**.
- **How the auction houses work:**
  - Cuts: faction house 5%, Blackwater 15%.
  - Listings run 12, 24 or 48 hours.
  - Stackable goods sell as commodities, cheapest first.
  - Blackwater purchases arrive by mail immediately; sale proceeds take about 1 hour.
- **Rules:** Blizzard's April 2025 policy forbids trading **gold** across factions on Classic
  versions, and Forever has "Temporary Economy Holds". Safe practice: move goods,
  never gold; no 1c handovers; click every purchase yourself; snipers exist.
- **Earlier price observations (Alliance EU PvP, 12 Nov 2026):**
  - Mithril Bar ~9s, Gold Bar ~8s, Iron Bar ~3s.
  - Gyrochronatom ~11s, Advanced Target Dummy ~40s, Goblin Sapper Charge ~60s, Mithril Tube 15s
    (crafting costs 27s).
  - Many engineering prices were falling fast (7-day medians 2–3× higher), as players levelled into the 200s.
- **Money convention used everywhere:** g / s / c; coppers only under 10s; 10s and up rounded to silver.
- **Credit lines used before:** "Prices from AHledger" (linked) when AHledger data is quoted. The
  site itself credits Blizzard's API.

## 12. Changes at import (13 Nov 2026, Claude Code)

- **Unpacked** all 14 embedded files (every checksum matched), built `pipeline/items.json`
  (38,353 items) and ran `tools/selftest.py` (OK).
- **Live check** against Blizzard's API with the owner's client: Alliance 110 had 228,818 listings,
  Horde 113 had 265,359 and Blackwater 116 had 33,942 (snapshot 15:25 UTC). Warming mode, 80 items
  per list, as expected on a first run.
- **Item names:** the first live run left 10–18 of each list's 80 items as "Item #…". There were
  1,010 unknown ids, looked up in id order, 300 a run; only 383 of them are listed on both a faction
  house and Blackwater (the only ones that can be opportunities), and just 100 of those were reached.
  `cmd_run` now looks those up first. After that, 2–5 per list stayed unnamed: 11 new Forever items
  (ids 284382–288206) for which Blizzard's item API returned 404. A miss used to be cached for good;
  it is now retried once a day (`needs_name`), so names appear once Blizzard adds them.
- **Action versions** bumped (see section 10): GitHub moved Actions to Node 24.
- **`pipeline/fingerprint.json` removed.** It was a stored sample of AHledger prices; AHledger's terms
  forbid keeping its data past the Cache-Control time, and this repo is public. It also could not
  separate the PvP houses from their look-alike group. `match_scores` now exits with a clear message
  if ids are ever null and no fingerprint exists. Re-verify ids against fresh in-game prices.
- **60-day schedule pause (section 10):** GitHub pauses scheduled workflows in public repos after 60
  days without repository activity, and a community report says only commits on the default branch
  count. No keep-alive was added: GitHub disabled the best-known keep-alive action's repository for
  breaking its terms. GitHub warns before pausing; re-enable from the Actions tab with one click, or
  any commit to `main` resets the clock.

## 13. Changes after launch (13 Nov 2026, from the owner's feedback)

- **Home → Blackwater priced off the other faction.** Almost nobody buys on Blackwater to use an item:
  the buyers are the other faction's traders, who resell at home. So the selling price is half the other
  faction's (cautious) price, or the cheapest Blackwater listing if that is lower (competition).
  Blackwater's own asks above that are ignored. Volume and "your share" come from the other faction's
  sales. Owner's rule: any quantity cap comes from Alliance/Horde, never from Blackwater.
- **No top-80 cut.** The warming list was cut to 80 by profit per item, which hid cheap, high-return lines
  such as Recipe: Elixir of Giant Growth (Horde 3s20c, Alliance 78s89c, Blackwater 50s at 16:25 UTC).
  Every qualifying item is listed now (164–314 per view on the first live data).
- **Earlier sales figures.** Sorting by market size silently fell back to profit per item while warming.
  Sales estimates now start after the first hourly diff (marked early); warming only means "no volume
  filter yet". Sort options that still lack data are disabled with a note.
- **New sections, modelled on the owner's cross-faction PDF:** a real ranked table (buy, sell, back per
  1g and market a day shaded, sold a day, bar), the return-vs-market chart (log axes in gold, ×2/×10
  guides, labels, hover/tap tooltip, dot size by profit a day, ring for shopping-list items), the ten
  biggest markets and ten biggest returns, and **Busiest on Blackwater**.
- **Sortable column headings** (owner's request): tap a heading to sort, again to flip; an arrow and a
  highlighted heading show the order. Works on both tables; the drop-down follows.
- **Busiest on Blackwater keeps only items someone can profit from** (owner's rule): an item stays if
  the Alliance or Horde price after the 5% cut beats the average price paid on Blackwater. Items dearer
  on Blackwater than both houses pay are dropped: mostly players moving goods between their own
  characters. On 2 hours of live data (17:25 UTC) that kept 201 items (~6,220g a day) and dropped 527
  (~14,165g a day), so about two-thirds of Blackwater's gold volume looks like cross-character transfers.
- **Dark theme is the default** (owner's request); parchment is one tap away and remembered.
- **Chart search** (owner's request): a box above the chart keeps only items whose name contains the text
  (e.g. "recipe") and labels them.
- **World of Warcraft look**: dark leather and gold trim (parchment in light mode), Cinzel headings,
  quality colours, gold/silver/copper coin colours, Alliance/Horde switch colours, in-game style tooltip.
  No Blizzard art or logos.
- **Scan coverage checked**: each run reads every listing (about 240k Alliance, 278k Horde, 36k
  Blackwater; ~6,200 items per faction house); all items from the PDF were present. AHledger was not
  adopted: it lacks Blackwater, and its terms forbid keeping or republishing its data.
- Listing ids are stable between snapshots (~80% of listings keep their id an hour later), so the sales
  diff is sound; cancellations still leak in, as documented.
