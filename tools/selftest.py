#!/usr/bin/env python3
"""Offline self-test: builds 9 hours of fake Blizzard responses for three houses,
runs the pipeline over them and checks the output. No network, no credentials.

    python3 tools/selftest.py            # leaves the site data in /tmp/ft-selftest/out
    python3 -m http.server -d site 8000  # after copying out/latest.json to site/data/
"""
import json, os, random, shutil, subprocess, sys
from datetime import datetime, timedelta, timezone
from email.utils import format_datetime

ROOT = os.path.normpath(os.path.join(os.path.dirname(os.path.abspath(__file__)), '..'))
TMP = os.environ.get('FT_SELFTEST_DIR', '/tmp/ft-selftest')
ITEMS = json.load(open(os.path.join(ROOT, 'pipeline', 'items.json')))
HOUSES = {113: 'Alliance Auction House', 114: 'Horde Auction House', 125: 'Blackwater Auction House'}
random.seed(42)


def market():
    """Random 'true' prices per house: neutral is thinner and noisier."""
    ids = [int(i) for i, v in ITEMS.items() if v[2] in ('Trade Goods', 'Consumable', 'Reagent', 'Recipe', 'Quest', '')][:1500]
    gear = [int(i) for i, v in ITEMS.items() if v[2] in ('Armor', 'Weapon') and not v[4]][:300]
    m = {}
    for i in ids + gear:
        base = random.choice([5, 20, 80, 300, 1200, 5000, 20000, 90000])
        spd = random.choice([0.5, 2, 8, 30, 120, 600]) if i in ids else random.choice([0.3, 1, 3])
        m[i] = {
            113: dict(price=base * random.uniform(0.8, 1.25), spd=spd, qty=int(spd * random.uniform(1, 6)) + 1),
            114: dict(price=base * random.uniform(0.8, 1.25), spd=spd, qty=int(spd * random.uniform(1, 6)) + 1),
            125: dict(price=base * random.uniform(0.4, 2.5), spd=spd * 0.1, qty=int(spd * random.uniform(0.2, 2)) + 1),
        }
        if random.random() < 0.15:          # a big gap between the two factions, as on the live servers
            m[i][random.choice([113, 114])]['price'] *= random.uniform(2.5, 6)
    return m, set(gear)


def check_diff_sales():
    """Cancel-and-repost at the same price is not a sale; a plain disappearance is."""
    sys.path.insert(0, os.path.join(ROOT, 'pipeline'))
    import update
    prev = {'1': [4563, 1, 200000, 'LONG'], '2': [4563, 1, 200000, 'VERY_LONG'], '3': [2589, 20, 25, 'LONG']}
    cur = [dict(id=11, item=4563, qty=1, unit=200000, tl='VERY_LONG', var=''),      # reposted at the same 20g
           dict(id=12, item=4563, qty=1, unit=199999, tl='VERY_LONG', var='')]      # reposted a copper cheaper
    sold = update.diff_sales(prev, cur, 1.0)
    assert 4563 not in sold, sold                      # both 20g listings were cancels, not sales
    assert sold.get(2589) == [20, 500], sold           # the vanished Linen Cloth stack was bought
    assert update.cautious({'low': 200000}, None, 498) == 498 and update.cautious(None, None, None) is None
    print('diff_sales and cautious checks OK')


def check_engineering(eng):
    """Each recipe's materials cost what its parts add up to, each part costs the cheapest of its
    options (auction house, vendor, making it), and the profit is the sale after the 5% cut minus that."""
    def check_node(p):
        opts = [x for x in ((p['ah'] * p['qty']) if p.get('ah') else None, (p['v'] * p['qty']) if p.get('v') else None,
                             (p['mk'] * p['qty']) if p.get('mk') else None) if x is not None]
        if p['how'] == 'none':
            assert not opts and p['c'] is None, p
            return
        assert p['c'] <= min(opts) + 1 + p['qty'], p          # the chosen way is the cheapest (whole-copper rounding)
        if p['how'] == 'make':
            assert abs(sum(k['c'] for k in p['p']) - p['c']) <= len(p['p']), p
            for k in p['p']:
                check_node(k)
    n = 0
    for fac, f in eng['factions'].items():
        for o in f['items']:
            assert o['id'] not in (10542, 10543, 10545, 10587, 10645, 10725, 10727), o['name']   # bind on pickup: never listed
            for p in o['parts']:
                check_node(p)
            if o['cost'] is not None:
                assert o['cost'] == sum(p['c'] for p in o['parts']), o['name']
            if o['profit'] is not None:
                assert abs(o['back'] - o['sell'] * 0.95 * o['n']) <= 1 + 0.01 * o['n'] and abs(o['profit'] - (o['back'] - o['cost'])) <= 1, o['name']
                n += 1
            assert (o['profitDay'] is None) or (o['profit'] > 0 and o['soldDay']), o['name']
    priced = sum(1 for o in eng['factions']['alliance']['items'] if o['cost'] is not None)
    print('engineering:', len(eng['factions']['alliance']['items']), 'recipes,', priced, 'with materials priced,', n, 'with a profit figure (both factions)')


def main():
    check_diff_sales()
    shutil.rmtree(TMP, ignore_errors=True)
    os.makedirs(TMP)
    m, gear = market()
    aid = [1]
    book = {h: [] for h in HOUSES}
    for i, per in m.items():
        for h, t in per.items():
            for _ in range(t['qty']):
                aid[0] += 1
                book[h].append(dict(id=aid[0], item=i, qty=1 if i in gear else random.choice([1, 5, 20]),
                                    unit=int(t['price'] * random.uniform(1, 1.4)), tl=random.choice(['LONG', 'VERY_LONG', 'MEDIUM'])))
    cfg = os.path.join(TMP, 'config.json')
    json.dump({'region': 'eu', 'ruleset': 1, 'ruleset_name': 'PvP', 'houses': {'alliance': 113, 'horde': 114, 'neutral': 125},
               'cuts': {'faction': 0.05, 'neutral': 0.15}}, open(cfg, 'w'))
    t0 = datetime(2026, 11, 13, 6, tzinfo=timezone.utc)
    for hour in range(9):
        d = os.path.join(TMP, 'fx', f'h{hour}')
        os.makedirs(d)
        lm = format_datetime(t0 + timedelta(hours=hour), usegmt=True)
        json.dump({'body': {'auctions': [{'id': h, 'name': n} for h, n in HOUSES.items()]}},
                  open(os.path.join(d, 'data_wow_ruleset_1_auctions.json'), 'w'))
        for h in HOUSES:
            rows = book[h]
            auc = [{'id': r['id'], 'item': {'id': r['item']}, 'buyout': r['unit'] * r['qty'], 'quantity': r['qty'], 'time_left': r['tl']}
                   for r in rows if r['item'] in gear]
            com = [{'id': r['id'], 'item': {'id': r['item']}, 'unit_price': r['unit'], 'quantity': r['qty'], 'time_left': r['tl']}
                   for r in rows if r['item'] not in gear]
            json.dump({'body': {'id': h, 'name': HOUSES[h], 'auctions': auc, 'commodities': {'href': 'x'}}, 'last_modified': lm},
                      open(os.path.join(d, f'data_wow_ruleset_1_auctions_{h}.json'), 'w'))
            json.dump({'body': {'auctions': com}, 'last_modified': lm},
                      open(os.path.join(d, f'data_wow_ruleset_1_auctions_{h}_commodities.json'), 'w'))
            # one hour of trading: buyers take the cheapest units; sellers relist
            by = {}
            for r in rows:
                by.setdefault(r['item'], []).append(r)
            nxt = []
            for i, lst in by.items():
                want = m[i][h]['spd'] / 24
                n = int(want) + (random.random() < want % 1)
                lst.sort(key=lambda r: r['unit'])
                for r in lst:
                    if n <= 0:
                        break
                    take = min(r['qty'], n); r['qty'] -= take; n -= take
                for r in lst:
                    r['tl'] = {'MEDIUM': 'SHORT'}.get(r['tl'], r['tl'])
                nxt += [r for r in lst if r['qty'] > 0]
                if random.random() < min(1, want):
                    aid[0] += 1
                    nxt.append(dict(id=aid[0], item=i, qty=1, unit=int(m[i][h]['price'] * random.uniform(1, 1.3)), tl='VERY_LONG'))
            book[h] = nxt
        env = dict(os.environ, FT_CONFIG=cfg)
        r = subprocess.run([sys.executable, '-I', os.path.join(ROOT, 'pipeline', 'update.py'), 'run', '--fixtures', d,
                            '--state', os.path.join(TMP, 'state'), '--out', os.path.join(TMP, 'out')],
                           env=env, capture_output=True, text=True)
        if r.returncode:
            print(r.stdout, r.stderr); sys.exit(f'pipeline failed at hour {hour}')
        print(f'hour {hour}:', ' | '.join(l for l in r.stdout.splitlines() if '->' in l))
    out = json.load(open(os.path.join(TMP, 'out', 'latest.json')))
    for fac in ('alliance', 'horde'):
        for k in ('buyNeutralSellHome', 'buyHomeSellNeutral'):
            v = out['factions'][fac][k]
            assert v['warming'] is False and v['salesHours'] >= 6, (fac, k, v['salesHours'])
            assert v['items'], (fac, k)
            o = v['items'][0]
            assert o['mult'] >= 1.15 and o['profitDay'] > 0 and o['back'] > o['buy'], o
            assert all(a['profitDay'] >= b['profitDay'] for a, b in zip(v['items'], v['items'][1:]))
        # home -> Blackwater: sell = min(half the other faction's price, cheapest Blackwater listing)
        v = out['factions'][fac]['buyHomeSellNeutral']
        assert v['refFaction'] == ('horde' if fac == 'alliance' else 'alliance') and v['share'] == 0.5, v.keys()
        for o in v['items']:
            assert o['refPaid'] is None or o['ref'] <= o['refPaid'] + 1, o   # never above what buyers paid
            assert abs(o['half'] - o['ref'] * 0.5) <= 1, o
            assert o['sell'] <= o['half'] + 1 and (o['dstLow'] is None or o['sell'] <= o['dstLow']), o
            assert (o['sell'] == o['dstLow']) if o['undercut'] else abs(o['sell'] - o['half']) <= 1, o
            assert abs(o['back'] - o['sell'] * 0.85) <= 1, o
        print(fac, 'home->Blackwater:', len(v['items']), 'items,', sum(o['undercut'] for o in v['items']),
              'matching a cheaper Blackwater listing,', sum(o['dstLow'] is None for o in v['items']), 'not on Blackwater')
    top = out['neutralTop']['items']
    assert top and all(a['marketDay'] >= b['marketDay'] for a, b in zip(top, top[1:])), 'neutralTop'
    assert all(o['soldDay'] >= 0.5 and o['avg'] > 0 for o in top), 'neutralTop values'
    for o in top:   # only items that resell at a profit in a faction house after its 5% cut
        assert o['resellX'] > 1 and abs(o['resellX'] - max(x for x in (o['xA'], o['xH']) if x)) < 1e-6, o
        for ref, x in ((o['aRef'], o['xA']), (o['hRef'], o['xH'])):
            assert (ref is None) == (x is None), o
            if x is not None:   # compared with the Blackwater price now (cheapest listing), else the average paid
                basis = o['low'] if o['basisNow'] else o['avg']
                assert o['basisNow'] == bool(o['low']), o
                lo = (ref - 0.5) * 0.95 / (basis + 0.5)
                hi = (ref + 0.5) * 0.95 / max(0.01, basis - 0.5)
                assert lo - 1e-3 <= x <= hi + 1e-3, (o, lo, hi)
    for o in top:   # the site shows the cheapest listing now in each house; Alliance and Horde are always listed here
        assert o['aLow'] and o['hLow'] and ('low' in o), o
    assert out.get('siteVersion') == 'dev', out.get('siteVersion')   # stamped with the commit by update.yml
    # price history: one file per listed item, 9 hourly points, medians in use, never planned above the median
    sdir = os.path.join(TMP, 'out', 'series')
    ids = {o['id'] for f in out['factions'].values() for v in f.values() for o in v['items']} | {o['id'] for o in top}
    files = set(int(n[:-5]) for n in os.listdir(sdir))
    assert ids <= files, ('missing history files', len(ids - files))
    one = json.load(open(os.path.join(sdir, f'{next(iter(ids))}.json')))
    assert max(len(v) for v in one['h'].values()) == 9, {k: len(v) for k, v in one['h'].items()}
    assert any(s.get('med') for s in one['s'].values()) and out['trackingSince'] == '2026-11-13', one['s']
    for n in list(files)[:200]:   # cheapest since tracking began is never dearer than the 7-day cheapest
        f = json.load(open(os.path.join(sdir, f'{n}.json')))
        for h, st in f['s'].items():
            assert not (st['min7'] and st['minAll'] and st['minAll'][0] > st['min7']), (n, h, st)
    for fac in ('alliance', 'horde'):
        for o in out['factions'][fac]['buyHomeSellNeutral']['items']:
            assert o['refMed'] is None or o['ref'] <= o['refMed'] + 1, o
        for o in out['factions'][fac]['buyNeutralSellHome']['items']:
            assert o['dstMed'] is None or o['sell'] <= o['dstMed'] + 1, o
    eng = json.load(open(os.path.join(TMP, 'out', 'engineering.json')))
    check_engineering(eng)
    for f in eng['factions'].values():
        assert {o['id'] for o in f['items'] if o['qty']} <= files, 'engineering items without a history file'
    print('price history:', len(files), 'item files, sample', one['id'], {k: len(v) for k, v in one['h'].items()}, 'medians', {k: v.get('med') for k, v in one['s'].items()})
    print('busiest: left out', out['neutralTop']['hiddenItems'], 'items dearer on Blackwater than either house pays')
    print('busiest on Blackwater:', len(top), 'items, top', top[0]['name'], top[0]['marketDay'], 'copper a day')
    print('selftest OK ->', os.path.join(TMP, 'out', 'latest.json'))


if __name__ == '__main__':
    main()
