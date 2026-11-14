#!/usr/bin/env python3
"""Build pipeline/recipes.json: every Classic Engineering recipe, every smelting recipe
(Mining), and the vendor prices of the reagents that vendors sell.

Source: the MIT-licensed npm package wow-classic-items (the same one as the item names).
Run:  python3 tools/build_recipes.py

  crafts: [{id, prof: 'eng'|'smelt', skill, n (average made per craft), r: [[reagent, qty]],
            learn: 'trainer'|'schematic', how: text, school: 'gnomish'|'goblin'|None}]
  vendor: {reagent id: copper}          (unlimited vendor stock only)
  bop:    [engineering products that bind when picked up: they can't be sold]
"""
import io, json, os, tarfile, urllib.request

URL = 'https://registry.npmjs.org/wow-classic-items/-/wow-classic-items-2.0.1.tgz'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'pipeline', 'recipes.json')
MAX_ID = 23000          # later expansions' items start above this; Classic Engineering stops below it
MAX_SKILL = 300

# Classic specialisations: taught by the Gnomish or Goblin trainer, only to that kind of engineer.
GNOMISH = {10713: 'Plans: Inlaid Mithril Cylinder', 10716: 'Gnomish Shrink Ray', 10545: 'Gnomish Goggles',
           10720: 'Gnomish Net-o-Matic Projector', 10721: 'Gnomish Harm Prevention Belt', 10724: 'Gnomish Rocket Boots',
           10725: 'Gnomish Battle Chicken', 10726: 'Gnomish Mind Control Cap', 10645: 'Gnomish Death Ray'}
GOBLIN = {10644: 'Recipe: Goblin Rocket Fuel', 10577: 'Goblin Mortar', 10543: 'Goblin Construction Helmet',
          10542: 'Goblin Mining Helmet', 10646: 'Goblin Sapper Charge', 7189: 'Goblin Rocket Boots',
          10587: 'Goblin Bomb Dispenser', 10588: 'Goblin Rocket Helmet', 10727: 'Goblin Dragon Gun'}


def how_learnt(schem):
    """A sentence on where a schematic comes from, from the item database's source field."""
    src = schem.get('source') or {}
    cat, name = src.get('category'), src.get('name')
    if cat == 'Vendor':
        return 'Schematic sold by ' + (name or 'a vendor')
    if cat == 'Boss Drop':
        return 'Schematic dropped by ' + (name or 'a boss')
    if cat in ('Rare Drop', 'Zone Drop'):
        return 'Schematic: world drop'
    if cat == 'Quest':
        return 'Schematic from a quest'
    return 'Schematic'


def main():
    raw = urllib.request.urlopen(URL, timeout=120).read()
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as tf:
        data = json.load(tf.extractfile('package/data/json/data.json'))
    by = {x['itemId']: x for x in data}
    for ids in (GNOMISH, GOBLIN):
        for i, n in ids.items():
            assert by[i]['name'] == n, (i, by[i]['name'], n)
    crafts, reagents, bop = [], set(), []
    for x in data:
        for cb in x.get('createdBy') or []:
            prof = {'Engineering': 'eng', 'Mining': 'smelt'}.get(cb.get('category'))
            if not prof or cb['requiredSkill'] > MAX_SKILL or x['itemId'] >= MAX_ID:
                continue
            r = [[z['itemId'], z['amount']] for z in cb['reagents']]
            if any(i >= MAX_ID for i, _ in r) or any(i == x['itemId'] for i, _ in r):
                continue                                   # later content, or a reload of the item itself
            lo, hi = cb['amount']
            schems = [by[s] for s in (cb.get('recipes') or []) if s in by and s < MAX_ID]
            c = {'id': x['itemId'], 'prof': prof, 'skill': cb['requiredSkill'], 'n': (lo + hi) / 2, 'r': r}
            if prof == 'eng':
                school = 'gnomish' if x['itemId'] in GNOMISH else 'goblin' if x['itemId'] in GOBLIN else None
                if school:
                    c.update(learn='trainer', how=school.capitalize() + ' engineering trainer (specialisation)', school=school)
                elif schems:
                    c.update(learn='schematic', how=how_learnt(schems[0]), school=None, schematic=schems[0]['itemId'])
                else:
                    c.update(learn='trainer', how='Engineering trainer', school=None)
                tips = ' '.join(t.get('label', '') for t in x.get('tooltip', []))
                if 'Binds when picked up' in tips:
                    bop.append(x['itemId'])
            crafts.append(c)
            reagents.update(i for i, _ in r)
    crafts.sort(key=lambda c: (c['prof'], c['skill'], c['id']))
    vendor = {str(i): by[i]['vendorPrice'] for i in sorted(reagents) if i in by and by[i].get('vendorPrice')}
    out = {'source': 'wow-classic-items 2.0.1 (MIT)', 'crafts': crafts, 'vendor': vendor, 'bop': sorted(set(bop))}
    with open(OUT, 'w') as f:
        json.dump(out, f, separators=(',', ':'))
    print(sum(c['prof'] == 'eng' for c in crafts), 'engineering and', sum(c['prof'] == 'smelt' for c in crafts),
          'smelting recipes,', len(vendor), 'vendor reagents,', len(bop), 'bind-on-pickup products ->', os.path.normpath(OUT))


if __name__ == '__main__':
    main()
