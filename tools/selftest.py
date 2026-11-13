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
    return m, set(gear)


def main():
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
    print('selftest OK ->', os.path.join(TMP, 'out', 'latest.json'))


if __name__ == '__main__':
    main()
