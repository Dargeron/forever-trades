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

TOKEN_URL = 'https://oauth.battle.net/token'
TL_SAFE_SHORT_GAP = {'LONG', 'VERY_LONG'}      # can't expire within ~2 h
TL_SAFE_LONG_GAP = {'VERY_LONG'}               # can't expire within 12 h
HISTORY_DAYS = 14
WINDOW_DAYS = 7
MIN_SALES_HOURS = 6                            # below this: "warming", every price gap is listed, no volume filter
EARLY_SALES_HOURS = 1                          # sales estimates are shown (flagged early) from the first hourly diff


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
          - the same item was relisted with the same quantity at a lower price
            (a typical undercut), or
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
            match = next((f for f in relists if not f[2] and f[0] == qty and f[1] < unit), None)
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


def cautious(d, typ):
    """The price to plan with on a house: its lowest listing, or its 7-day typical price if
    that is lower; the typical alone if nothing is listed now; None if neither is known."""
    if d:
        return d['low'] if typ is None else min(d['low'], typ)
    return typ


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


def busiest(hist, house, data, now_dt, names_cache):
    """Items with the most gold changing hands a day on `house`: estimated units sold a day
    and the copper they sold for, over up to 7 days. Every item seen selling 0.5+ a day."""
    h = hist.get(house) or {}
    cutoff = day_of(now_dt - timedelta(days=WINDOW_DAYS))
    hours = sum(v for d, v in (h.get('hours') or {}).items() if d > cutoff)
    out = []
    if hours < EARLY_SALES_HOURS:
        return out, hours
    S = data[house]['stats']
    A, Hd = data['alliance']['stats'], data['horde']['stats']
    for item, days in (h.get('items') or {}).items():
        units = sum(v[0] for d, v in days.items() if d > cutoff)
        copper = sum(v[1] for d, v in days.items() if d > cutoff)
        spd = units / hours * 24
        if units <= 0 or spd < 0.5:
            continue
        i = int(item)
        info = item_info(i, names_cache)
        s, a, hh = S.get(i), A.get(i), Hd.get(i)
        avg = copper / units
        a_low, h_low = (a['low'] if a else None), (hh['low'] if hh else None)
        out.append(dict(id=i, name=info[0], q=info[1], cls=info[2], soldDay=round(spd, 2),
                        avg=int(round(avg)), marketDay=int(round(copper / hours * 24)),
                        low=s['low'] if s else None, qty=s['qty'] if s else 0,
                        aLow=a_low, hLow=h_low, route=route_of(avg, a_low, h_low)))
    out.sort(key=lambda o: -o['marketDay'])
    return out, hours


def route_of(bw, a, h, faction_cut=None, neutral_cut=None):
    """Who is making money when this item sells on Blackwater at `bw`? 'A>H' if an Alliance
    seller beats the Alliance price after Blackwater's cut AND a Horde buyer can still resell
    it in the Horde house at a profit after that house's cut; 'H>A' the other way round; None
    if neither holds (then it is mostly bought for use, or the estimate is noise)."""
    fc = CONFIG['cuts']['faction'] if faction_cut is None else faction_cut
    nc = CONFIG['cuts']['neutral'] if neutral_cut is None else neutral_cut
    if not a or not h or not bw:
        return None
    if bw * (1 - nc) > a and h * (1 - fc) > bw:
        return 'A>H'
    if bw * (1 - nc) > h and a * (1 - fc) > bw:
        return 'H>A'
    return None


def opportunities(src, dst, src_house, dst_house, dst_cut, hist, now_dt, names_cache):
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
        sell = cautious(d, typ)
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
            dstTyp=int(typ) if typ else None, soldDay=round(spd, 2) if spd is not None else None,
            unitsDay=round(units, 2) if units is not None else None,
            mult=round(mult, 3), profitEach=int(round(profit_each)),
            profitDay=int(round(profit_day)) if profit_day is not None else None,
            marketDay=int(round(spd * sell)) if spd else None,
            daysStock=round(dst_qty / spd, 1) if spd else None,
            tag='Solid' if mult >= 2 else 'Fair', trend=trend_of(d, typ), ladder=ladder))
    return finish(out, warming), warming, dst_hours


def to_blackwater(home, neu, other, home_key, other_key, cut, share, hist, now_dt, names_cache):
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
        ref = cautious(o, typ)
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
    result = {'generated': now.isoformat(), 'region': CONFIG['region'].upper(), 'ruleset': CONFIG['ruleset_name'],
              'houseIds': houses, 'houses': {}, 'factions': {}}
    for key in houses:
        h = data[key]
        _, _, hours = item_history(hist, key, -1, now)
        result['houses'][key] = {'snapshot': h['snap'].isoformat(), 'auctions': h['auctions'],
                                 'items': len(h['stats']), 'salesHours': round(hours, 1)}
    share = CONFIG.get('other_faction_share', 0.5)
    for fac in ('alliance', 'horde'):
        other = 'horde' if fac == 'alliance' else 'alliance'
        home_in, w1, h1 = opportunities(data['neutral'], data[fac], 'neutral', fac, cuts['faction'], hist, now, names_cache)
        to_neu, w2, h2 = to_blackwater(data[fac], data['neutral'], data[other], fac, other, cuts['neutral'], share,
                                       hist, now, names_cache)
        result['factions'][fac] = {
            'buyNeutralSellHome': {'warming': w1, 'salesHours': round(h1, 1), 'items': home_in},
            'buyHomeSellNeutral': {'warming': w2, 'salesHours': round(h2, 1), 'refFaction': other, 'share': share,
                                   'items': to_neu}}
    top, top_hours = busiest(hist, 'neutral', data, now, names_cache)
    result['neutralTop'] = {'salesHours': round(top_hours, 1), 'items': top}
    os.makedirs(args.out, exist_ok=True)
    jsave(os.path.join(args.out, 'latest.json'), result)
    meta = {'updated': now.isoformat(), 'house_ids': houses, 'house_match': meta_prev.get('house_match'),
            'houses': {k: {'id': houses[k], 'last_modified': data[k]['lm'], 'snapshot': data[k]['snap'].isoformat()} for k in houses}}
    jsave(os.path.join(state, 'meta.json'), meta)
    jsave(os.path.join(state, 'history.json.gz'), hist)
    jsave(os.path.join(state, 'names.json'), names_cache)
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
