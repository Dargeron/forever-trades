#!/usr/bin/env python3
"""Turn the output of the "Read recipes from Blizzard" workflow (recipes_forever.json, an artifact of
.github/workflows/recipes.yml) into pipeline/forever_recipes.json, the WoW: Forever recipe list that
tools/build_recipes.py uses. Blizzard's game-data API is the source of truth for reagents and amounts;
it has no skill levels or trainer/schematic info, which come from the Classic database.

    python3 tools/import_forever_recipes.py path/to/recipes_forever.json
    python3 tools/build_recipes.py
"""
import json, os, sys
from datetime import datetime, timezone

OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'pipeline', 'forever_recipes.json')
SKIP_CATEGORIES = {'SEASON OF DISCOVERY'}           # Season of Discovery recipes are served too, but are not Forever's
QUALITY = {'POOR': 0, 'COMMON': 1, 'UNCOMMON': 2, 'RARE': 3, 'EPIC': 4, 'LEGENDARY': 5}


def main(path):
    d = json.load(open(path))
    recipes = []
    for prof, p in d['professions'].items():
        for t in p['tiers'].values():
            cat_of = {str(r['id']): c.get('name') for c in (t.get('tier') or {}).get('categories') or [] for r in c.get('recipes') or []}
            for rid, b in sorted(t['recipes'].items(), key=lambda kv: int(kv[0])):
                cat = cat_of.get(rid)
                if not b or cat in SKIP_CATEGORIES:
                    continue
                if prof == 'Mining' and cat != 'Smelted Bars':
                    continue                                  # Mining's camping items are not smelting
                item = (b.get('crafted_item') or b.get('alliance_crafted_item') or {}).get('id')
                if not item:
                    continue                                  # enchant-like recipes that make no item
                q = b.get('crafted_quantity') or {}
                n = q.get('value') or (q.get('minimum', 1) + q.get('maximum', 1)) / 2
                r = [[x['reagent']['id'], x['quantity']] for x in b.get('reagents') or []]
                names = {str(x['reagent']['id']): x['reagent'].get('name') for x in b.get('reagents') or []}
                recipes.append({'rid': int(rid), 'name': b.get('name'), 'cat': cat, 'prof': 'eng' if prof == 'Engineering' else 'smelt',
                                'id': item, 'n': n, 'r': r, 'reagentNames': names})
    items = {}
    for i, v in (d.get('items') or {}).items():
        items[i] = [v.get('name') or f'Item #{i}', QUALITY.get(v.get('quality'), 1), v.get('class') or '', v.get('subclass') or '',
                    1 if v.get('binding') == 'ON_ACQUIRE' else 0, v.get('sell') or 0]
    out = {'source': "Blizzard's WoW: Forever game-data API (static-forever-eu), read with .github/workflows/recipes.yml",
           'read': datetime.now(timezone.utc).strftime('%Y-%m-%d'), 'recipes': recipes, 'items': items}
    with open(OUT, 'w') as f:
        json.dump(out, f, separators=(',', ':'), ensure_ascii=False)
    print(len(recipes), 'recipes,', len(items), 'Forever-only items ->', os.path.normpath(OUT))


if __name__ == '__main__':
    main(sys.argv[1])
