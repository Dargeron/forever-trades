#!/usr/bin/env python3
"""Build pipeline/recipes.json: every Engineering and smelting recipe, and the vendor prices of the
reagents that vendors sell.

Recipes (reagents, amounts, made per craft) come from WoW: Forever itself when pipeline/forever_recipes.json
exists (Blizzard's game-data API: see tools/import_forever_recipes.py and the "Read recipes from Blizzard"
workflow); Forever changed several Classic recipes and added many. Skill levels, schematics and vendor
prices come from the MIT-licensed npm package wow-classic-items (Classic), which is also the fallback list.
Run:  python3 tools/build_recipes.py

  crafts: [{id, prof: 'eng'|'smelt', skill (None if unknown), n (average made per craft), r: [[reagent, qty]],
            cat (Blizzard's category), learn: 'trainer'|'schematic'|'unknown', how: text, school: 'gnomish'|'goblin'|None}]
  names:  {id: [name, quality, class, subclass]} for items that only exist in WoW: Forever
  sell:   {id: vendor sell price} for those items (auction deposits)
  vendor: {reagent id: copper}          (unlimited vendor stock only)
  bop:    [engineering products that bind when picked up: they can't be sold]
"""
import io, json, os, re, tarfile, urllib.request

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


FOREVER = os.path.join(os.path.dirname(OUT), 'forever_recipes.json')     # tools/import_forever_recipes.py
# Skill levels of recipes that only exist in WoW: Forever, from wow.gg's Forever engineering list (8 Nov 2026):
# Blizzard's API gives reagents but no skill levels. Others stay unknown (the site can still show them).
FOREVER_SKILL = {'Reagent Bot': 20, 'SAF-T Dynamite': 25, 'SAF-T Jumbo Dynamite': 150, 'Satchel of Bronze Bombs': 165,
                 'Clanking Cord': 175, 'Gizmo Girdle': 175, 'Whimsical Waistwrap': 175, 'Shafety Sheep': 175,
                 'SAF-T Bell': 175, 'EZ-Thro Grenade': 200, 'Bent Goggles': 200, 'Dented Goggles': 200, 'Floppy Goggles': 200,
                 'Stuckbutton Goggles': 200, 'Centaur Banner Deployment Device': 190, 'EZ-Thro Fireproof Fuse': 190,
                 'EZ-Thro Bronze Mortar': 190}


def rocket_skill(name):
    """Fireworks come in colours that share a recipe level: Small 125, Large 175, Cluster 225, Large Cluster 275."""
    if re.fullmatch(r'Large \w+ Rocket Cluster', name): return 275
    if re.fullmatch(r'\w+ Rocket Cluster', name): return 225
    if re.fullmatch(r'Large \w+ Rocket', name): return 175
    if re.fullmatch(r'Small \w+ Rocket', name): return 125
    return None


def main():
    raw = urllib.request.urlopen(URL, timeout=120).read()
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as tf:
        data = json.load(tf.extractfile('package/data/json/data.json'))
    by = {x['itemId']: x for x in data}
    for ids in (GNOMISH, GOBLIN):
        for i, n in ids.items():
            assert by[i]['name'] == n, (i, by[i]['name'], n)
    # Classic recipes: the fallback list, and skill levels / where each recipe is learnt
    classic, bop = [], set()
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
                c.update(learn_info(x['itemId'], schems))
                tips = ' '.join(t.get('label', '') for t in x.get('tooltip', []))
                if 'Binds when picked up' in tips:
                    bop.add(x['itemId'])
            classic.append(c)
    classic_by = {}
    for c in classic:
        classic_by.setdefault(c['id'], c)
    names = {}
    if os.path.exists(FOREVER):
        fv = json.load(open(FOREVER))
        source = 'WoW: Forever recipes from Blizzard (' + fv['read'] + '); skill levels and schematics from wow-classic-items 2.0.1 (MIT)'
        crafts = []
        for fr in fv['recipes']:
            i = fr['id']
            if any(rid == i for rid, _ in fr['r']):
                continue
            cl = classic_by.get(i)
            item = fv['items'].get(str(i))
            name = by[i]['name'] if i in by else (item[0] if item else fr['name'])
            if name.endswith(' NYI'):
                continue                                   # "not yet implemented" in the game data
            if i not in by and not item:
                names[str(i)] = [fr['name'], 1, '', '']    # the item API had nothing: use the recipe's name
            c = {'id': i, 'prof': fr['prof'], 'n': fr['n'], 'r': fr['r'], 'cat': fr['cat'],
                 'skill': cl['skill'] if cl else (FOREVER_SKILL.get(name) or rocket_skill(name))}
            if fr['prof'] == 'eng':
                if cl:
                    c.update({k: cl[k] for k in ('learn', 'how', 'school', 'schematic') if k in cl})
                else:
                    c.update(learn_info(i, []) if i in GNOMISH or i in GOBLIN else
                             {'learn': 'unknown', 'how': 'WoW: Forever recipe (where it is learnt is not in our data)', 'school': None})
                if item and item[4]:
                    bop.add(i)
            crafts.append(c)
            for rid, rname in (fr.get('reagentNames') or {}).items():
                if int(rid) not in by:
                    names.setdefault(rid, [rname, 1, '', ''])
        for i, v in fv['items'].items():
            names[i] = v[:4]
        sell = {i: v[5] for i, v in fv['items'].items() if v[5]}
    else:
        source = 'wow-classic-items 2.0.1 (MIT)'
        crafts, sell = classic, {}
    crafts.sort(key=lambda c: (c['prof'], c['skill'] if c['skill'] is not None else 999, c['id']))
    reagents = {i for c in crafts for i, _ in c['r']}
    vendor = {str(i): by[i]['vendorPrice'] for i in sorted(reagents) if i in by and by[i].get('vendorPrice')}
    bop &= {c['id'] for c in crafts}
    out = {'source': source, 'crafts': crafts, 'vendor': vendor, 'bop': sorted(bop), 'names': names, 'sell': sell}
    with open(OUT, 'w') as f:
        json.dump(out, f, separators=(',', ':'), ensure_ascii=False)
    eng = [c for c in crafts if c['prof'] == 'eng']
    print(len(eng), 'engineering recipes (', sum(c['skill'] is None for c in eng), 'with unknown skill ) and',
          sum(c['prof'] == 'smelt' for c in crafts), 'smelting recipes,', len(vendor), 'vendor reagents,', len(out['bop']),
          'bind-on-pickup products,', len(names), 'Forever-only item names ->', os.path.normpath(OUT))


def learn_info(i, schems):
    school = 'gnomish' if i in GNOMISH else 'goblin' if i in GOBLIN else None
    if school:
        return {'learn': 'trainer', 'how': school.capitalize() + ' engineering trainer (specialisation)', 'school': school}
    if schems:
        return {'learn': 'schematic', 'how': how_learnt(schems[0]), 'school': None, 'schematic': schems[0]['itemId']}
    return {'learn': 'trainer', 'how': 'Engineering trainer', 'school': None}


if __name__ == '__main__':
    main()
