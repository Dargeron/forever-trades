#!/usr/bin/env python3
"""
Forever Trades - hourly price update for WoW: Forever, EU PvP.

Reads the Alliance, Horde and Blackwater (neutral) auction houses from
Blizzard's Battle.net API, estimates what sold by comparing each snapshot
with the previous one, keeps 14 days of history, and writes the JSON the
website reads.

Usage
  python3 pipeline/update.py run   --state STATE_DIR --out site/data
  python3 pipeline/update.py probe                    # list houses + fingerprints
  python3 pipeline/update.py run   --fixtures DIR ... # offline test with saved responses

Credentials come from the environment: BLIZZARD_CLIENT_ID, BLIZZARD_CLIENT_SECRET.
Only the standard library is used.
"""
import argparse, base64, gzip, json, math, os, sys, time, urllib.error, urllib.parse, urllib.request
from datetime import datetime, timezone, timedelta
from email.utils import parsedate_to_datetime, format_datetime

HERE = os.path.dirname(os.path.abspath(__file__))
CONFIG = json.load(open(os.environ.get('FT_CONFIG') or os.path.join(HERE, 'config.json')))
ITEMS = json.load(open(os.path.join(HERE, 'items.json')))
RECIPES = json.load(open(os.path.join(HERE, 'recipes.json')))     # tools/build_recipes.py

TOKEN_URL = 'https://oauth.battle.net/token'
TL_SAFE_SHORT_GAP = {'LONG', 'VERY_LONG'}      # can't expire within ~2 h
TL_SAFE_LONG_GAP = {'VERY_LONG'}               # can't expire within 12 h
HISTORY_DAYS = 14
WINDOW_DAYS = 7
MIN_SALES_HOURS = 6                            # below this: "warming", every price gap is listed, no volume filter
EARLY_SALES_HOURS = 1                          # sales estimates are shown (flagged early) from the first hourly diff
SERIES_HOURS = 72                              # hourly price points kept per item and house (state/series.json.gz)
MIN_MEDIAN_POINTS = 3                          # hourly points needed before the median counts


# --------------------------------------------------------------------------- API
class Api:
    def __init__(self, fixtures=None):
        self.fixtures = fixtures
        self.region = CONFIG['region']
        self.host = f"https://{self.region}.api.blizzard.com"
        self.token = None
        self.calls = 0

    def _token(self):
        cid, sec = os.environ.get('BLIZZARD_CLIENT_ID'), os.environ.get('BLIZZARD_CLIENT_SECRET')
        if not cid or not sec:
            sys.exit('Missing BLIZZARD_CLIENT_ID / BLIZZARD_CLIENT_SECRET')
        req = urllib.request.Request(TOKEN_URL, data=b'grant_type=client_credentials', method='POST')
        req.add_header('Authorization', 'Basic ' + base64.b64encode(f'{cid}:{sec}'.encode()).decode())
        req.add_header('Content-Type', 'application/x-www-form-urlencoded')
        with urllib.request.urlopen(req, timeout=30) as r:
            self.token = json.load(r)['access_token']

    def get(self, path, ns='dynamic', since=None, retries=3):
        """Returns (status, json_or_None, last_modified_header)."""
        if self.fixtures:
            key = path.strip('/').replace('/', '_') or 'root'
            p = os.path.join(self.fixtures, key + '.json')
            if not os.path.exists(p):
                return 404, None, None
            d = json.load(open(p))
            return 200, d.get('body'), d.get('last_modified')
        if not self.token:
            self._token()
        q = urllib.parse.urlencode({'namespace': f'{ns}-forever-{self.region}', 'locale': 'en_GB'})
        url = f"{self.host}{path}{'&' if '?' in path else '?'}{q}"
        for attempt in range(retries):
            req = urllib.request.Request(url)
            req.add_header('Authorization', f'Bearer {self.token}')
            req.add_header('Accept-Encoding', 'gzip')
            if since:
                req.add_header('If-Modified-Since', since)
            try:
                self.calls += 1
                with urllib.request.urlopen(req, timeout=120) as r:
                    raw = r.read()
                    if r.headers.get('Content-Encoding') == 'gzip':
                        raw = gzip.decompress(raw)
                    return r.status, json.loads(raw), r.headers.get('Last-Modified')
            except urllib.error.HTTPError as e:
                if e.code == 304:
                    return 304, None, since
                if e.code == 401 and attempt == 0:
                    self._token(); continue
                if e.code in (429, 500, 502, 503, 504) and attempt < retries - 1:
                    time.sleep(2 + 3 * attempt); continue
                return e.code, None, None
            except (urllib.error.URLError, TimeoutError):
                if attempt < retries - 1:
                    time.sleep(3 + 3 * attempt); continue
                raise
        return 599, None, None


def house_path(hid, sub=''):
    return f"/data/wow/ruleset/{CONFIG['ruleset']}/auctions/{hid}{sub}"


def fetch_house(api, hid, since=None):
    """Returns (status, auctions list, last_modified). Auctions are normalised to
    dicts: id, item, qty, unit (copper per unit), tl, var (variant key for gear)."""
    st, body, lm = api.get(house_path(hid), since=since)
    if st != 200:
        return st, None, lm
    rows = []
    auc = body.get('auctions')
    if isinstance(auc, dict) and auc.get('href'):          # some builds return a link
        st2, b2, _ = api.get(house_path(hid, '/auctions'))
        auc = (b2 or {}).get('auctions') if st2 == 200 else []
    for a in auc or []:
        it = a.get('item') or {}
        q = a.get('quantity') or 1
        if a.get('buyout'):
            unit = a['buyout'] / q
        elif a.get('unit_price'):
            unit = a['unit_price']
        else:
            continue                                           # bid-only
        var = ''
        for k in ('rand', 'bonus_lists', 'suffix'):          # random suffixes ("of the Bear") show up as bonus_lists;
            if it.get(k):                                     # 'modifiers' (type 28) varies per listing and is ignored
                var += f"{k}={it[k]};"
        rows.append(dict(id=a['id'], item=it.get('id'), qty=q, unit=unit, tl=a.get('time_left', ''), var=var))
    com = body.get('commodities')
    clist = []
    if isinstance(com, list):
        clist = com
    elif isinstance(com, dict):
        if isinstance(com.get('auctions'), list):
            clist = com['auctions']
        else:                                                   # a link to the commodities endpoint
            st3, b3, _ = api.get(house_path(hid, '/commodities'))
            clist = (b3 or {}).get('auctions', []) if st3 == 200 else []
    for a in clist or []:
        if not a.get('unit_price'):
            continue
        rows.append(dict(id=a['id'], item=(a.get('item') or {}).get('id'), qty=a.get('quantity') or 1,
                         unit=a['unit_price'], tl=a.get('time_left', ''), var=''))
    return 200, rows, lm


# --------------------------------------------------------------------------- stats
def summarise(rows):
    """Per item: lowest unit price, 15th-percentile unit price ('market'), qty, price ladder, variants."""
    by = {}
    for r in rows:
        if r['item'] is None:
            continue
        by.setdefault(r['item'], []).append(r)
    out = {}
    for item, lst in by.items():
        lst.sort(key=lambda r: r['unit'])
        qty = sum(r['qty'] for r in lst)
        target, acc, mkt = max(1, math.ceil(qty * 0.15)), 0, lst[-1]['unit']
        for r in lst:
            acc += r['qty']
            if acc >= target:
                mkt = r['unit']; break
        ladder, last = [], None
        for r in lst:
            u = int(round(r['unit']))
            if ladder and ladder[-1][0] == u:
                ladder[-1][1] += r['qty']
            else:
                if len(ladder) >= 40:
                    break
                ladder.append([u, r['qty']])
        out[item] = dict(low=int(round(lst[0]['unit'])), mkt=int(round(mkt)), qty=qty, n=len(lst),
                         ladder=ladder, variants=len({r['var'] for r in lst}))
    return out


def diff_sales(prev, cur, gap_hours):
    """Estimate units and copper sold between two snapshots, per item.

    The API never reports sales, so we infer them:
      * a listing that shrank (partial buy of a stack) is a sale;
      * a listing that vanished while it still had 2+ hours left (12+ if snapshots
        were skipped) was bought or cancelled. We treat it as a cancellation when
          - the same item was relisted with the same quantity at the same or a lower
            price (an undercut, or a cancel-and-repost: on 13 Nov two 20g Billy Clubs
            vanished and came back at 20g and were wrongly counted as sales), or
          - an older, cheaper listing of the item is still there (buyers take the
            cheapest stack first, so the dearer one was most likely pulled).
    """
    if gap_hours <= 0 or gap_hours > 12:
        return {}
    safe = TL_SAFE_SHORT_GAP if gap_hours <= 2.2 else TL_SAFE_LONG_GAP
    cur_by_id = {r['id']: r for r in cur}
    prev_ids = set()
    survivors_min, gone = {}, {}
    sold = {}
    for aid, v in prev.items():
        item, qty, unit, tl = v[:4]
        aid = int(aid)
        prev_ids.add(aid)
        now = cur_by_id.get(aid)
        if now is not None:
            survivors_min[item] = min(survivors_min.get(item, unit), unit)
            if now['qty'] < qty and tl in safe:
                s = sold.setdefault(item, [0, 0])
                s[0] += qty - now['qty']; s[1] += (qty - now['qty']) * unit
        elif tl in safe:
            gone.setdefault(item, []).append((qty, unit))
    if not gone:
        return sold
    fresh = {}
    for r in cur:
        if r['id'] not in prev_ids and r['item'] in gone:
            fresh.setdefault(r['item'], []).append([r['qty'], r['unit'], False])
    for item, lst in gone.items():
        floor = survivors_min.get(item)
        relists = fresh.get(item, [])
        for qty, unit in lst:
            match = next((f for f in relists if not f[2] and f[0] == qty and f[1] <= unit * 1.0001), None)
            if match:
                match[2] = True
                continue
            if floor is not None and unit > floor * 1.0001:
                continue
            s = sold.setdefault(item, [0, 0])
            s[0] += qty; s[1] += qty * unit
    return sold


# --------------------------------------------------------------------------- state
def jload(path, default):
    try:
        with (gzip.open(path, 'rt') if path.endswith('.gz') else open(path)) as f:
            return json.load(f)
    except (FileNotFoundError, json.JSONDecodeError, OSError):
        return default


def jsave(path, obj):
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + '.tmp'
    with (gzip.open(tmp, 'wt') if path.endswith('.gz') else open(tmp, 'w')) as f:
        json.dump(obj, f, separators=(',', ':'))
    os.replace(tmp, path)


def day_of(dt):
    return dt.strftime('%Y-%m-%d')


def update_history(hist, house, stats, sold, snap_dt, gap_hours):
    h = hist.setdefault(house, {'items': {}, 'hours': {}, 'samples': {}})
    day = day_of(snap_dt)
    if sold is not None and 0 < gap_hours <= 12:
        h['hours'][day] = round(h['hours'].get(day, 0) + gap_hours, 3)
    h['samples'][day] = h['samples'].get(day, 0) + 1
    for item, s in stats.items():
        rec = h['items'].setdefault(str(item), {}).setdefault(day, [0, 0, 0, 0, 0, 0])
        # [sold_units, sold_copper, mkt_sum, mkt_n, low_min, qty_sum]
        rec[2] += s['mkt']; rec[3] += 1; rec[5] += s['qty']
        rec[4] = s['low'] if rec[4] == 0 else min(rec[4], s['low'])
    for item, (u, c) in (sold or {}).items():
        rec = h['items'].setdefault(str(item), {}).setdefault(day, [0, 0, 0, 0, 0, 0])
        rec[0] += u; rec[1] += int(c)
    # prune
    cutoff = day_of(snap_dt - timedelta(days=HISTORY_DAYS))
    for k in ('hours', 'samples'):
        h[k] = {d: v for d, v in h[k].items() if d >= cutoff}
    for item in list(h['items']):
        days = {d: v for d, v in h['items'][item].items() if d >= cutoff}
        if days:
            h['items'][item] = days
        else:
            del h['items'][item]


def item_history(hist, house, item, now_dt):
    """sold_per_day (None before the first hour of diffs; early until MIN_SALES_HOURS),
    typical price over 7 days, hours of data."""
    h = hist.get(house) or {}
    cutoff = day_of(now_dt - timedelta(days=WINDOW_DAYS))
    hours = sum(v for d, v in (h.get('hours') or {}).items() if d > cutoff)
    days = {d: v for d, v in ((h.get('items') or {}).get(str(item)) or {}).items() if d > cutoff}
    units = sum(v[0] for v in days.values())
    spd = units / hours * 24 if hours >= EARLY_SALES_HOURS else None
    daily = sorted(v[2] / v[3] for v in days.values() if v[3] >= 3)
    typ = daily[len(daily) // 2] if len(daily) >= 2 else None
    return spd, typ, hours


def avg_paid(hist, house, item, now_dt):
    """Average price buyers actually paid for the item on this house over up to 7 days
    (estimated sales), or None if none were seen."""
    h = hist.get(house) or {}
    cutoff = day_of(now_dt - timedelta(days=WINDOW_DAYS))
    days = [v for d, v in ((h.get('items') or {}).get(str(item)) or {}).items() if d > cutoff]
    units = sum(v[0] for v in days)
    return sum(v[1] for v in days) / units if units else None


# --------------------------------------------------------------------------- price history
def update_series(series, house, stats, snap_dt):
    """Record this snapshot's cheapest listing and market price (15th percentile) per item.
    series[house] = {'t': [epoch minutes], 'i': {item: [[low, mkt] or 0 per time]}}, last
    SERIES_HOURS hours. The same snapshot is never recorded twice (forced rebuilds)."""
    s = series.setdefault(house, {'t': [], 'i': {}})
    tmin = int(snap_dt.timestamp() // 60)
    if s['t'] and s['t'][-1] >= tmin:
        return
    n = len(s['t'])
    s['t'].append(tmin)
    for item, st in stats.items():
        s['i'].setdefault(str(item), [0] * n).append([st['low'], st['mkt']])
    for arr in s['i'].values():
        if len(arr) < n + 1:
            arr.append(0)
    drop = 0
    while drop < len(s['t']) and s['t'][drop] < tmin - SERIES_HOURS * 60:
        drop += 1
    if drop:
        s['t'] = s['t'][drop:]
        s['i'] = {k: arr[drop:] for k, arr in s['i'].items()}
    s['i'] = {k: arr for k, arr in s['i'].items() if any(arr)}


def series_median(series, house, item):
    """Median hourly market price over the last SERIES_HOURS, once MIN_MEDIAN_POINTS exist."""
    arr = ((series.get(house) or {}).get('i') or {}).get(str(item))
    vals = sorted(p[1] for p in (arr or []) if p)
    return vals[len(vals) // 2] if len(vals) >= MIN_MEDIAN_POINTS else None


def update_alltime(alltime, house, stats, snap_dt):
    """Cheapest listing ever seen per item and house since tracking began: [copper, date]."""
    a = alltime.setdefault(house, {})
    day = day_of(snap_dt)
    for item, st in stats.items():
        cur = a.get(str(item))
        if cur is None or st['low'] < cur[0]:
            a[str(item)] = [st['low'], day]


def seed_alltime(alltime, hist):
    """The daily history holds each day's cheapest listing and can go back further than the
    cheapest-ever record (which began on the evening of 13 Nov): never let 'cheapest since
    tracking began' be dearer than a day's minimum."""
    for house, h in hist.items():
        a = alltime.setdefault(house, {})
        for item, days in (h.get('items') or {}).items():
            for d, v in days.items():
                if v[4] and (item not in a or v[4] < a[item][0]):
                    a[item] = [v[4], d]


def min_low_days(hist, house, item, now_dt, days=WINDOW_DAYS):
    recs = ((hist.get(house) or {}).get('items') or {}).get(str(item)) or {}
    cutoff = day_of(now_dt - timedelta(days=days))
    vals = [v[4] for d, v in recs.items() if d > cutoff and v[4]]
    return min(vals) if vals else None


def item_file(i, data, series, hist, alltime, now_dt):
    """Everything the site's price-history panel needs for one item, in all three houses."""
    out = {'id': i, 'h': {}, 'd': {}, 's': {}}
    for house in ('alliance', 'horde', 'neutral'):
        s = series.get(house) or {}
        arr = (s.get('i') or {}).get(str(i)) or []
        out['h'][house] = [[s['t'][k], p[0], p[1]] for k, p in enumerate(arr) if p]
        recs = ((hist.get(house) or {}).get('items') or {}).get(str(i)) or {}
        out['d'][house] = [[d, v[4] or None, round(v[2] / v[3]) if v[3] else None, round(v[1] / v[0]) if v[0] else None, v[0]]
                           for d, v in sorted(recs.items())]
        st = data[house]['stats'].get(i)
        paid = avg_paid(hist, house, i, now_dt)
        out['s'][house] = {'now': st['low'] if st else None, 'med': series_median(series, house, i),
                           'min7': min_low_days(hist, house, i, now_dt), 'minAll': (alltime.get(house) or {}).get(str(i)),
                           'paid': int(round(paid)) if paid else None, 'qty': st['qty'] if st else 0}
    return out


# --------------------------------------------------------------------------- analysis
def item_info(i, names_cache):
    v = ITEMS.get(str(i))
    if v:
        return v
    c = names_cache.get(str(i))
    if c:
        return c
    return [f'Item #{i}', 1, '', '', 0]


def walk(ladder, units):
    """Average price to buy `units` from a ladder of [price, qty]."""
    need, cost, got = units, 0, 0
    for p, q in ladder:
        take = min(q, need - got)
        cost += take * p; got += take
        if got >= need:
            break
    return (cost / got if got else None), got


def gear_skip(info, s):
    """Random-suffix gear ("of the Bear"): prices of different suffixes are not comparable."""
    return info[4] or (info[2] in ('Armor', 'Weapon') and s['variants'] > 1)


def cautious(d, typ, paid=None, med=None):
    """The price to plan with on a house: the lowest of its cheapest listing now, its 3-day
    median market price (hourly), its 7-day typical price and the average price buyers actually
    paid. Spike protection: when the reasonable copies have sold and only a few silly ones are
    left (13 Nov: only 20g Billy Clubs in the Horde house while buyers paid a few silver), the
    median and the paid price keep the plan honest. None if nothing is known."""
    vals = [x for x in ((d['low'] if d else None), med, typ, paid) if x]
    return min(vals) if vals else None


def trend_of(d, typ):
    if typ and d:
        return 'falling' if d['low'] < 0.6 * typ else ('rising' if d['low'] > 1.5 * typ else None)
    return None


def plan(s, back, spd, warming):
    """How many to buy a day, and at what average price, given what one unit brings back
    (`back`) and how many sell a day where the buyers are (`spd`). None unless it clears
    x1.15 and (once out of warming) 3s a day. While warming, items with no sales seen yet
    stay listed as price gaps. Returns (units, avg, mult, profit_each, profit_day, ladder)."""
    if spd is None or (warming and spd < 0.5):
        units, avg = None, s['low']
    else:
        if spd < 0.5:
            return None
        units = min(0.25 * spd, s['qty'])
        avg, _ = walk(s['ladder'], max(1, math.ceil(units)))
        if not avg:
            return None
    mult = back / avg
    if mult < 1.15:
        return None
    profit_each = back - avg
    profit_day = units * profit_each if units is not None else None
    if not warming and profit_day is not None and profit_day < 300:
        return None
    need = math.ceil(units * 2) if units else 5
    ladder, acc = [], 0
    for p, q in s['ladder']:
        ladder.append([p, q]); acc += q
        if acc >= need or len(ladder) >= 12:
            break
    return units, avg, mult, profit_each, profit_day, ladder


def finish(out, warming):
    """Every qualifying item, never a silent top-N: by profit a day, then profit per item."""
    out.sort(key=lambda o: (-(o['profitDay'] or 0), -o['profitEach']))
    return out


def busiest(hist, house, data, now_dt, names_cache, series=None):
    """Items people buy on Blackwater (`house`) that can be resold at a profit in the Alliance
    or Horde house: estimated units sold a day and the copper they sold for, over up to 7 days.
    The resell ratio compares a faction house's cautious price, after its cut, with what it costs
    on Blackwater NOW: the cheapest listing, or what buyers paid if nothing is listed (the owner
    saw x1.19 next to a Blackwater price dearer than the faction's, because the ratio used the
    average paid). An item stays only if that ratio beats 1; the rest are left out (mostly
    players moving goods between their own characters). Returns (items, hours, hidden)."""
    h = hist.get(house) or {}
    cutoff = day_of(now_dt - timedelta(days=WINDOW_DAYS))
    hours = sum(v for d, v in (h.get('hours') or {}).items() if d > cutoff)
    out, hidden = [], {'items': 0, 'gold': 0}
    if hours < EARLY_SALES_HOURS:
        return out, hours, hidden
    keep = 1 - CONFIG['cuts']['faction']
    S = data[house]['stats']
    A, Hd = data['alliance']['stats'], data['horde']['stats']
    for item, days in (h.get('items') or {}).items():
        units = sum(v[0] for d, v in days.items() if d > cutoff)
        copper = sum(v[1] for d, v in days.items() if d > cutoff)
        spd = units / hours * 24
        if units <= 0 or spd < 0.5:
            continue
        i = int(item)
        avg = copper / units
        a_ref = cautious(A.get(i), item_history(hist, 'alliance', i, now_dt)[1], avg_paid(hist, 'alliance', i, now_dt),
                         series_median(series or {}, 'alliance', i))
        h_ref = cautious(Hd.get(i), item_history(hist, 'horde', i, now_dt)[1], avg_paid(hist, 'horde', i, now_dt),
                         series_median(series or {}, 'horde', i))
        s = S.get(i)
        basis = s['low'] if s else avg      # buy price on Blackwater: cheapest listing now, else the average paid
        xa = a_ref * keep / basis if a_ref else None
        xh = h_ref * keep / basis if h_ref else None
        best = max([x for x in (xa, xh) if x is not None], default=None)
        if not best or best <= 1:
            hidden['items'] += 1
            hidden['gold'] += copper / hours * 24
            continue
        info = item_info(i, names_cache)
        a, hh = A.get(i), Hd.get(i)
        out.append(dict(id=i, name=info[0], q=info[1], cls=info[2], soldDay=round(spd, 2),
                        avg=int(round(avg)), marketDay=int(round(copper / hours * 24)),
                        low=s['low'] if s else None, qty=s['qty'] if s else 0,
                        aLow=a['low'] if a else None, hLow=hh['low'] if hh else None,      # cheapest listing now
                        aRef=int(round(a_ref)) if a_ref else None, hRef=int(round(h_ref)) if h_ref else None,
                        xA=round(xa, 3) if xa else None, xH=round(xh, 3) if xh else None,
                        resellX=round(best, 3), basisNow=bool(s)))
    out.sort(key=lambda o: -o['marketDay'])
    hidden['gold'] = int(round(hidden['gold']))
    return out, hours, hidden


def opportunities(src, dst, src_house, dst_house, dst_cut, hist, now_dt, names_cache, series=None):
    """Buy on `src`, sell on `dst` at its cautious price (used for Blackwater -> home)."""
    S, D = src['stats'], dst['stats']
    out = []
    dst_hours = item_history(hist, dst_house, -1, now_dt)[2]
    warming = dst_hours < MIN_SALES_HOURS
    for item, s in S.items():
        info = item_info(item, names_cache)
        if gear_skip(info, s):
            continue
        d = D.get(item)
        spd, typ, _ = item_history(hist, dst_house, item, now_dt)
        paid = avg_paid(hist, dst_house, item, now_dt)
        med = series_median(series or {}, dst_house, item)
        sell = cautious(d, typ, paid, med)
        if not sell:
            continue
        back = sell * (1 - dst_cut)
        if back <= s['low'] * 1.15:
            continue
        p = plan(s, back, spd, warming)
        if not p:
            continue
        units, avg, mult, profit_each, profit_day, ladder = p
        typ_src = item_history(hist, src_house, item, now_dt)[1]
        dst_qty = d['qty'] if d else 0
        out.append(dict(
            id=item, name=info[0], q=info[1], cls=info[2], sub=info[3],
            buy=int(round(avg)), low=s['low'], srcQty=s['qty'], srcTyp=int(typ_src) if typ_src else None,
            sell=int(round(sell)), back=int(round(back)), dstQty=dst_qty, dstLow=d['low'] if d else None,
            dstTyp=int(typ) if typ else None, dstPaid=int(round(paid)) if paid else None, dstMed=med,
            soldDay=round(spd, 2) if spd is not None else None,
            unitsDay=round(units, 2) if units is not None else None,
            mult=round(mult, 3), profitEach=int(round(profit_each)),
            profitDay=int(round(profit_day)) if profit_day is not None else None,
            marketDay=int(round(spd * sell)) if spd else None,
            daysStock=round(dst_qty / spd, 1) if spd else None,
            tag='Solid' if mult >= 2 else 'Fair', trend=trend_of(d, typ), ladder=ladder))
    return finish(out, warming), warming, dst_hours


def to_blackwater(home, neu, other, home_key, other_key, cut, share, hist, now_dt, names_cache, series=None):
    """Buy at home, sell on Blackwater to the other faction's traders.

    Almost nobody buys on Blackwater to use the item: the buyers are traders of the other
    faction, who resell it in their own house. So Blackwater's asking prices (often stale and
    far too high) are never the reference; the other faction's price is. We list at `share`
    (half) of it, so their traders still make a profit, whether or not the item is listed on
    Blackwater. If someone already sells it on Blackwater for less than that, it is
    competition, and we can only match the cheapest Blackwater listing. Sales volume comes
    from the other faction's house, where the real demand is."""
    H, N, O = home['stats'], neu['stats'], other['stats']
    out = []
    hours = item_history(hist, other_key, -1, now_dt)[2]
    warming = hours < MIN_SALES_HOURS
    for item, s in H.items():
        info = item_info(item, names_cache)
        if gear_skip(info, s):
            continue
        o = O.get(item)
        spd, typ, _ = item_history(hist, other_key, item, now_dt)
        paid = avg_paid(hist, other_key, item, now_dt)
        med = series_median(series or {}, other_key, item)
        ref = cautious(o, typ, paid, med)
        if not ref:
            continue
        half = ref * share
        n = N.get(item)
        undercut = bool(n and n['low'] < half)
        sell = n['low'] if undercut else half
        back = sell * (1 - cut)
        if back <= s['low'] * 1.15:
            continue
        p = plan(s, back, spd, warming)
        if not p:
            continue
        units, avg, mult, profit_each, profit_day, ladder = p
        typ_src = item_history(hist, home_key, item, now_dt)[1]
        o_qty = o['qty'] if o else 0
        out.append(dict(
            id=item, name=info[0], q=info[1], cls=info[2], sub=info[3],
            buy=int(round(avg)), low=s['low'], srcQty=s['qty'], srcTyp=int(typ_src) if typ_src else None,
            ref=int(round(ref)), refLow=o['low'] if o else None, refTyp=int(typ) if typ else None, refQty=o_qty,
            refPaid=int(round(paid)) if paid else None, refMed=med,
            half=int(round(half)), undercut=undercut,
            sell=int(round(sell)), back=int(round(back)),
            dstQty=n['qty'] if n else 0, dstLow=n['low'] if n else None, dstTyp=None,
            soldDay=round(spd, 2) if spd is not None else None,
            unitsDay=round(units, 2) if units is not None else None,
            mult=round(mult, 3), profitEach=int(round(profit_each)),
            profitDay=int(round(profit_day)) if profit_day is not None else None,
            marketDay=int(round(spd * ref)) if spd else None,
            daysStock=round(o_qty / spd, 1) if spd else None,
            tag='Solid' if mult >= 2 else 'Fair', trend=trend_of(o, typ), ladder=ladder))
    return finish(out, warming), warming, hours


# --------------------------------------------------------------------------- engineering
def material_costs(fac, stats, hist, now_dt, series, names_cache):
    """Returns node(item, qty): the cheapest way to get `qty` of an item for a crafter on `fac`'s side.
    The options are buying it in that house (walking up its listings, or its recent price if none is
    listed now), buying it from a vendor, or making it: smelting ore into bars, or engineering parts
    (bolts, tubes, gizmos, powder, cores...) from their own materials, recursively."""
    makers = {}
    for c in RECIPES['crafts']:
        makers.setdefault(c['id'], []).append(c)
    vendor = {int(k): v for k, v in RECIPES['vendor'].items()}

    def ah_price(i, qty):
        s = stats.get(i)
        if s:
            avg, got = walk(s['ladder'], max(1, math.ceil(qty - 1e-9)))
            return avg, got < qty, False
        rec = series_median(series, fac, i) or item_history(hist, fac, i, now_dt)[1]
        return (rec, False, True) if rec else (None, False, False)

    def node(i, qty, stack=frozenset()):
        out = {'i': i, 'qty': round(qty, 3)}
        ah, short, recent = ah_price(i, qty)
        opts = []
        if ah:
            out['ah'] = int(round(ah))
            if short: out['short'] = True
            if recent: out['recent'] = True
            opts.append((ah * qty, 'ah', None))
        if i in vendor:
            out['v'] = vendor[i]
            opts.append((vendor[i] * qty, 'vendor', None))
        best_make = None
        if len(stack) < 6:
            for c in makers.get(i, []):
                crafts = qty / c['n']
                parts = [node(r, q * crafts, stack | {i}) for r, q in c['r'] if r not in stack]
                if len(parts) < len(c['r']) or any(p['c'] is None for p in parts):
                    continue
                total = sum(p['c'] for p in parts)
                if best_make is None or total < best_make[0]:
                    best_make = (total, c, parts)
        if best_make:
            total, c, parts = best_make
            out['mk'] = int(round(total / qty))
            opts.append((total, 'make', (c, parts)))
        if not opts:
            out.update(how='none', c=None)
            return out
        total, how, made = min(opts, key=lambda o: o[0])
        out.update(how=how, c=int(round(total)))
        if made:
            c, parts = made
            out.update(by=c['prof'], n=c['n'], crafts=round(qty / c['n'], 3), p=parts)
        return out
    return node


def engineering(fac, data, hist, now_dt, names_cache, series):
    """Every Engineering recipe for a crafter on `fac`'s side: what one craft's materials cost at the
    cheapest of buying, vendor and making them (see material_costs), against what the item sells for
    in that house (cautious price, after its 5% cut), and how many sell there a day. Items that bind
    when picked up can't be sold and are left out."""
    stats = data[fac]['stats']
    keep = 1 - CONFIG['cuts']['faction']
    node = material_costs(fac, stats, hist, now_dt, series, names_cache)
    bop = set(RECIPES['bop'])
    out = []
    for c in RECIPES['crafts']:
        if c['prof'] != 'eng' or c['id'] in bop:
            continue
        i, n = c['id'], c['n']
        parts = [node(r, q, frozenset({i})) for r, q in c['r']]
        missing = [item_info(p['i'], names_cache)[0] for p in parts if p['c'] is None]
        cost = None if missing else sum(p['c'] for p in parts)
        st = stats.get(i)
        spd, typ, _ = item_history(hist, fac, i, now_dt)
        paid = avg_paid(hist, fac, i, now_dt)
        med = series_median(series, fac, i)
        sell = cautious(st, typ, paid, med)
        back = sell * keep * n if sell else None
        profit = back - cost if back is not None and cost is not None else None
        info = item_info(i, names_cache)
        out.append(dict(
            id=i, name=info[0], q=info[1], skill=c['skill'], n=n, learn=c['learn'], how=c['how'], school=c['school'],
            cost=cost, sell=round(sell, 2) if sell else None, back=int(round(back)) if back else None,     # ammo: a few copper each
            profit=int(round(profit)) if profit is not None else None,
            mult=round(back / cost, 3) if back and cost else None,
            low=st['low'] if st else None, qty=st['qty'] if st else 0, paid=int(round(paid)) if paid else None,
            med=med, typ=int(typ) if typ else None, soldDay=round(spd, 2) if spd is not None else None,
            profitDay=int(round(profit / n * 0.25 * spd)) if profit and profit > 0 and spd else None,
            marketDay=int(round(spd * sell)) if spd and sell else None,
            missing=missing, parts=parts))
    out.sort(key=lambda o: -(o['profit'] if o['profit'] is not None else -1e15))
    return out


def node_ids(nodes):
    for p in nodes:
        yield p['i']
        yield from node_ids(p.get('p') or [])


# --------------------------------------------------------------------------- commands
def match_scores(api):
    """Score every auction house against an EU PvP fingerprint (pipeline/fingerprint.json:
    {"alliance"|"horde"|"neutral": {item_id: [lowest unit price, units listed]}}).
    Lower is closer: median |log price ratio| + 0.5 * median |log quantity ratio|.
    The repo ships without a fingerprint: the EU PvP ids are pinned in config.json."""
    fp_path = os.path.join(HERE, 'fingerprint.json')
    if not os.path.exists(fp_path):
        sys.exit('House ids are missing from pipeline/config.json and there is no pipeline/fingerprint.json to '
                 'match them with. Run the "Probe auction houses" workflow and set the ids by hand.')
    fp = json.load(open(fp_path))
    st, body, _ = api.get(f"/data/wow/ruleset/{CONFIG['ruleset']}/auctions/")
    if st != 200:
        sys.exit(f'Could not list auction houses (HTTP {st})')
    scores = []
    for h in (body or {}).get('auctions') or []:
        name = (h.get('name') or '').lower()
        side = 'alliance' if 'alliance' in name else 'horde' if 'horde' in name else 'neutral' if ('blackwater' in name or 'neutral' in name) else None
        if not side:
            continue
        st, rows, _ = fetch_house(api, h['id'])
        if st != 200 or not rows:
            scores.append(dict(id=h['id'], name=h.get('name'), side=side, score=None, items=0, auctions=0))
            continue
        stt = summarise(rows)
        dp, dq = [], []
        for i, (p, q) in fp[side].items():
            s_ = stt.get(int(i))
            if s_ and p and q:
                dp.append(abs(math.log(s_['low'] / p))); dq.append(abs(math.log(max(1, s_['qty']) / q)))
        med = lambda xs: sorted(xs)[len(xs) // 2] if xs else None
        sc = (med(dp) + 0.5 * med(dq)) if len(dp) >= 15 else None
        scores.append(dict(id=h['id'], name=h.get('name'), side=side, score=round(sc, 3) if sc is not None else None,
                           items=len(dp), auctions=len(rows)))
        del rows, stt
    return scores


def resolve_houses(api, meta_prev):
    """House ids: config.json wins; then the ids found on an earlier run; else match now."""
    cfg = CONFIG['houses']
    if all(cfg.values()):
        return dict(cfg)
    known = meta_prev.get('house_ids') or {}
    if all(known.get(k) for k in ('alliance', 'horde', 'neutral')):
        return {k: known[k] for k in ('alliance', 'horde', 'neutral')}
    print('Finding the EU PvP auction houses (first run only)...')
    scores = match_scores(api)
    chosen, report = {}, []
    for side in ('alliance', 'horde', 'neutral'):
        cands = sorted([s for s in scores if s['side'] == side and s['score'] is not None], key=lambda s: s['score'])
        for s in sorted([s for s in scores if s['side'] == side], key=lambda s: (s['score'] is None, s['score'] or 0)):
            print(f"  {side:8} house {s['id']}: score {s['score']}  ({s['items']} fingerprint items, {s['auctions']} auctions)")
        if not cands:
            sys.exit(f'No {side} house could be matched; set pipeline/config.json by hand (see the Probe workflow).')
        best = cands[0]
        gap = (cands[1]['score'] / best['score']) if len(cands) > 1 and best['score'] else None
        if gap is not None and gap < 1.25:
            print(f'  WARNING: {side} match is close (next best is only {gap:.2f}x worse). Check prices in game.')
        chosen[side] = best['id']
        report.append(dict(side=side, id=best['id'], score=best['score'], runner_up_ratio=round(gap, 2) if gap else None))
    if cfg.get('alliance'): chosen['alliance'] = cfg['alliance']
    if cfg.get('horde'): chosen['horde'] = cfg['horde']
    if cfg.get('neutral'): chosen['neutral'] = cfg['neutral']
    meta_prev['house_match'] = report
    print('Chosen EU PvP houses:', chosen)
    return chosen


def cmd_probe(api, args):
    st, body, _ = api.get(f"/data/wow/ruleset/{CONFIG['ruleset']}/auctions/")
    print('index status', st)
    houses = (body or {}).get('auctions') or []
    probe_items = [int(x) for x in (args.items or '2589,2592,4306,4338,14047,2770,2771,2772,2775,2776,3858,2835,2836,2838,7912,3575,3576,3577,3860,12359,10620,12365,4304,8170,3356,3357,3818,3821,8831,13463,13464,7076,7068,12808').split(',')]
    res = {'index': houses, 'houses': {}}
    for h in houses:
        hid = h.get('id')
        st, rows, lm = fetch_house(api, hid)
        if st != 200 or rows is None:
            res['houses'][hid] = {'name': h.get('name'), 'status': st}
            continue
        stt = summarise(rows)
        res['houses'][hid] = {'name': h.get('name'), 'status': st, 'last_modified': lm, 'auctions': len(rows),
                              'items': len(stt), 'units': sum(r['qty'] for r in rows),
                              'fingerprint': {i: [stt[i]['low'], stt[i]['qty']] for i in probe_items if i in stt},
                              'tl': {k: sum(1 for r in rows if r['tl'] == k) for k in ('SHORT', 'MEDIUM', 'LONG', 'VERY_LONG')}}
        print(hid, h.get('name'), len(rows), 'auctions', lm, file=sys.stderr)
    out = json.dumps(res, indent=1)
    if args.out_file:
        open(args.out_file, 'w').write(out)
    else:
        print(out)


def lookup_names(api, missing, names_cache, limit=300):
    n = 0
    for i in missing:
        if n >= limit:
            break
        n += 1
        st, body, _ = api.get(f'/data/wow/item/{i}', ns='static')
        if st == 200 and body:
            q = {'POOR': 0, 'COMMON': 1, 'UNCOMMON': 2, 'RARE': 3, 'EPIC': 4, 'LEGENDARY': 5}.get(((body.get('quality') or {}).get('type')), 1)
            names_cache[str(i)] = [body.get('name') or f'Item #{i}', q, (body.get('item_class') or {}).get('name', ''),
                                   (body.get('item_subclass') or {}).get('name', ''), 0]
        else:                                              # retried the next day (see needs_name)
            names_cache[str(i)] = [f'Item #{i}', 1, '', '', 0, 'miss', datetime.now(timezone.utc).strftime('%Y-%m-%d')]


def needs_name(i, names_cache, today):
    """True if the id has no name yet. A miss is retried once a day: Blizzard's item API
    adds new WoW: Forever items some time after they first appear on the auction house."""
    if str(i) in ITEMS:
        return False
    c = names_cache.get(str(i))
    return c is None or (len(c) > 5 and (len(c) < 7 or c[6] < today))


def cmd_run(api, args):
    state = args.state
    meta_prev = jload(os.path.join(state, 'meta.json'), {})
    houses = resolve_houses(api, meta_prev)
    hist = jload(os.path.join(state, 'history.json.gz'), {})
    names_cache = jload(os.path.join(state, 'names.json'), {})
    series = jload(os.path.join(state, 'series.json.gz'), {})
    alltime = jload(os.path.join(state, 'alltime.json.gz'), {})
    now = datetime.now(timezone.utc)
    data, changed = {}, False
    for key, hid in houses.items():
        prev_lm = (meta_prev.get('houses') or {}).get(key, {}).get('last_modified')
        st, rows, lm = fetch_house(api, hid, since=prev_lm)
        if st == 304 or (st == 200 and lm and lm == prev_lm):
            print(f'{key}: unchanged ({prev_lm})')
            data[key] = None
            continue
        if st != 200 or rows is None:
            print(f'{key}: HTTP {st}', file=sys.stderr)
            data[key] = None
            continue
        snap_dt = parsedate_to_datetime(lm) if lm else now
        prev = jload(os.path.join(state, f'snap_{key}.json.gz'), None)
        gap = 0
        sold = None
        if prev and prev.get('t'):
            gap = (snap_dt - datetime.fromisoformat(prev['t'])).total_seconds() / 3600
            sold = diff_sales(prev['a'], rows, gap)
        stats = summarise(rows)
        update_history(hist, key, stats, sold, snap_dt, gap)
        update_series(series, key, stats, snap_dt)
        update_alltime(alltime, key, stats, snap_dt)
        jsave(os.path.join(state, f'snap_{key}.json.gz'),
              {'t': snap_dt.isoformat(), 'a': {str(r['id']): [r['item'], r['qty'], round(r['unit'], 2), r['tl']] + ([r['var']] if r['var'] else [])
                                         for r in rows}})
        data[key] = {'stats': stats, 'snap': snap_dt, 'lm': lm, 'auctions': len(rows),
                     'sold_units': sum(v[0] for v in (sold or {}).values()), 'gap': gap}
        changed = True
        print(f'{key}: {len(rows)} auctions, {len(stats)} items, snapshot {lm}, gap {gap:.2f} h, '
              f'sold {data[key]["sold_units"]} units')
    if not changed and not args.force:
        print('Nothing new from Blizzard; skipping.')
        if args.github_output:
            open(args.github_output, 'a').write('changed=false\n')
        return
    # houses that did not change: rebuild stats from their stored snapshot
    for key in houses:
        if data.get(key) is None:
            prev = jload(os.path.join(state, f'snap_{key}.json.gz'), None)
            if not prev:
                sys.exit(f'No data for {key} yet')
            rows = [dict(id=int(a), item=v[0], qty=v[1], unit=v[2], tl=v[3], var=v[4] if len(v) > 4 else '') for a, v in prev['a'].items()]
            pm = (meta_prev.get('houses') or {}).get(key, {})
            data[key] = {'stats': summarise(rows), 'snap': datetime.fromisoformat(prev['t']), 'lm': pm.get('last_modified'),
                         'auctions': len(rows), 'sold_units': 0, 'gap': 0}
            update_series(series, key, data[key]['stats'], data[key]['snap'])     # no-op if already recorded
            update_alltime(alltime, key, data[key]['stats'], data[key]['snap'])
    # names for unknown items
    if not args.fixtures:
        seen = {k: set(data[k]['stats']) for k in houses}
        both = (seen['alliance'] | seen['horde']) & seen['neutral']    # only these can be opportunities
        today = day_of(now)
        missing = sorted({i for k in houses for i in seen[k] if needs_name(i, names_cache, today)},
                         key=lambda i: (i not in both, i))
        lookup_names(api, missing, names_cache)
    # analysis
    cuts = CONFIG['cuts']
    result = {'generated': now.isoformat(), 'siteVersion': (os.environ.get('GITHUB_SHA') or 'dev')[:12],
              'region': CONFIG['region'].upper(), 'ruleset': CONFIG['ruleset_name'],
              'houseIds': houses, 'houses': {}, 'factions': {},
              'trackingSince': min((d for h in hist.values() for d in (h.get('samples') or {})), default=day_of(now))}
    for key in houses:
        h = data[key]
        _, _, hours = item_history(hist, key, -1, now)
        result['houses'][key] = {'snapshot': h['snap'].isoformat(), 'auctions': h['auctions'],
                                 'items': len(h['stats']), 'salesHours': round(hours, 1)}
    share = CONFIG.get('other_faction_share', 0.5)
    for fac in ('alliance', 'horde'):
        other = 'horde' if fac == 'alliance' else 'alliance'
        home_in, w1, h1 = opportunities(data['neutral'], data[fac], 'neutral', fac, cuts['faction'], hist, now, names_cache,
                                        series)
        to_neu, w2, h2 = to_blackwater(data[fac], data['neutral'], data[other], fac, other, cuts['neutral'], share,
                                       hist, now, names_cache, series)
        result['factions'][fac] = {
            'buyNeutralSellHome': {'warming': w1, 'salesHours': round(h1, 1), 'items': home_in},
            'buyHomeSellNeutral': {'warming': w2, 'salesHours': round(h2, 1), 'refFaction': other, 'share': share,
                                   'items': to_neu}}
    top, top_hours, hidden = busiest(hist, 'neutral', data, now, names_cache, series)
    result['neutralTop'] = {'salesHours': round(top_hours, 1), 'items': top,
                            'hiddenItems': hidden['items'], 'hiddenGold': hidden['gold']}
    # Engineering tab: loaded by the site only when the tab is opened
    eng = {'generated': result['generated'], 'share': 0.25, 'factions': {}}
    for fac in ('alliance', 'horde'):
        eng['factions'][fac] = {'salesHours': round(item_history(hist, fac, -1, now)[2], 1),
                                'items': engineering(fac, data, hist, now, names_cache, series)}
    os.makedirs(args.out, exist_ok=True)
    jsave(os.path.join(args.out, 'latest.json'), result)
    seed_alltime(alltime, hist)
    # one small price-history file per listed item, loaded by the site when the item is opened
    ids = {o['id'] for f in result['factions'].values() for v in f.values() for o in v['items']} | {o['id'] for o in top}
    mats = set()
    for f in eng['factions'].values():
        for o in f['items']:
            mats.update(node_ids(o['parts']))
    eng['names'] = {str(i): item_info(i, names_cache)[:2] for i in sorted(mats)}     # materials' names and quality
    jsave(os.path.join(args.out, 'engineering.json'), eng)
    ids |= mats | {o['id'] for f in eng['factions'].values() for o in f['items']}
    sdir = os.path.join(args.out, 'series')
    os.makedirs(sdir, exist_ok=True)
    for i in ids:
        jsave(os.path.join(sdir, f'{i}.json'), item_file(i, data, series, hist, alltime, now))
    result_since = min((d for h in hist.values() for d in (h.get('samples') or {})), default=day_of(now))
    print(f'price history: {len(ids)} item files, series points per house',
          {k: len((series.get(k) or {}).get('t', [])) for k in houses}, 'tracking since', result_since)
    meta = {'updated': now.isoformat(), 'house_ids': houses, 'house_match': meta_prev.get('house_match'),
            'houses': {k: {'id': houses[k], 'last_modified': data[k]['lm'], 'snapshot': data[k]['snap'].isoformat()} for k in houses}}
    jsave(os.path.join(state, 'meta.json'), meta)
    jsave(os.path.join(state, 'history.json.gz'), hist)
    jsave(os.path.join(state, 'names.json'), names_cache)
    jsave(os.path.join(state, 'series.json.gz'), series)
    jsave(os.path.join(state, 'alltime.json.gz'), alltime)
    for fac in ('alliance', 'horde'):
        f = result['factions'][fac]
        print(fac, 'neutral->home', len(f['buyNeutralSellHome']['items']), '| home->neutral', len(f['buyHomeSellNeutral']['items']))
    if args.github_output:
        open(args.github_output, 'a').write('changed=true\n')


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('cmd', choices=['run', 'probe'])
    ap.add_argument('--state', default='state')
    ap.add_argument('--out', default='site/data')
    ap.add_argument('--fixtures')
    ap.add_argument('--force', action='store_true')
    ap.add_argument('--items')
    ap.add_argument('--out-file')
    ap.add_argument('--github-output', default=os.environ.get('GITHUB_OUTPUT'))
    args = ap.parse_args()
    api = Api(fixtures=args.fixtures)
    {'run': cmd_run, 'probe': cmd_probe}[args.cmd](api, args)
    print(f'API calls: {api.calls}', file=sys.stderr)


if __name__ == '__main__':
    main()
