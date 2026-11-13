#!/usr/bin/env python3
"""Build pipeline/items.json (id -> [name, quality, class, subclass, random_suffix_gear]).

Source: the MIT-licensed npm package wow-classic-items (Classic item database),
plus names of items added in WoW: Forever. Unknown ids are filled at run time by
pipeline/update.py from Blizzard's static-forever item API and cached in state.
Run:  python3 tools/build_items.py
"""
import io, json, os, tarfile, urllib.request

URL = 'https://registry.npmjs.org/wow-classic-items/-/wow-classic-items-2.0.1.tgz'
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'pipeline', 'items.json')
QUALITY = {'Poor': 0, 'Common': 1, 'Uncommon': 2, 'Rare': 3, 'Epic': 4, 'Legendary': 5, 'Artifact': 6, 'Heirloom': 7}

# Items added in WoW: Forever (not in the Classic database). Names checked on public item pages.
FOREVER_EXTRA = {
 211780:'Scroll: KWYJIBO',211785:'Scroll: CWAL',211786:'Scroll: CHAP BALK WELLES',211787:'Scroll: LOWER PING WHOMEVER',
 247786:'Mote of Magic',254432:'Carved Centaur Totem',248815:'Heavy Thorium Ore',248819:'Fel Crystal',248825:'Fel Leather',
 269900:'Centaur Banner Deployment Device',279941:'Blueprint: Tanning Rack',279961:'Journeyman Campfire Kit',279988:'Blueprint: Anvil',
 250366:"Recipe: Minor Cleric's Elixir",250370:'Recipe: Elixir of Fortitude',264081:"Craftsman's Writ: Advanced Target Dummy",
 264142:"Craftsman's Writ: Tranquil Mechanical Yeti",264077:"Craftsman's Writ: Truesilver Rod",264140:"Craftsman's Writ: Truesilver Transformer",
 264085:"Craftsman's Writ: Unstable Trigger",264065:"Craftsman's Writ: Goblin Rocket Fuel",264030:"Craftsman's Writ: Explosive Sheep",
 264132:"Craftsman's Writ: Arcanite Skeleton Key",264062:"Craftsman's Writ: Mana Potion",264107:"Craftsman's Writ: Shadoweave Robe",
 264215:'Schematic: SAF-T Bomb',254048:'Pattern: Radiant Cord',276999:'Cloudy Gustwoven Bracers',273295:'Seasonal Fish Steaks',
 248682:'Waylaid Crate: Apprentice Herbs',248683:'Waylaid Crate: Apprentice Ore',248684:'Waylaid Crate: Apprentice Textiles',248685:'Waylaid Crate: Apprentice Curiosities',
 248686:'Waylaid Crate: Journeyman Herbs',248687:'Waylaid Crate: Journeyman Ore',248688:'Waylaid Crate: Journeyman Textiles',248689:'Waylaid Crate: Journeyman Curiosities',
 248690:'Waylaid Crate: Earthly Expert Herbs',248691:'Waylaid Crate: Flowering Expert Herbs',248692:'Waylaid Crate: Expert Ore',248693:'Waylaid Crate: Expert Textiles',248694:'Waylaid Crate: Expert Curiosities',
 248695:'Waylaid Crate: Earthly Artisan Herbs',248696:'Waylaid Crate: Flowering Artisan Herbs',248697:'Waylaid Crate: Artisan Ore',248698:'Waylaid Crate: Artisan Textiles',248699:'Waylaid Crate: Artisan Curiosities',
 248702:'Waylaid Crate: Apprentice Fabrics',248703:'Waylaid Crate: Apprentice Ingots',248704:'Waylaid Crate: Apprentice Parts',
 248705:'Waylaid Crate: Journeyman Fabrics',248706:'Waylaid Crate: Journeyman Ingots',248707:'Waylaid Crate: Journeyman Parts',
 248708:'Waylaid Crate: Expert Fabrics',248709:'Waylaid Crate: Expert Ingots',248710:'Waylaid Crate: Expert Parts',
 248711:'Waylaid Crate: Artisan Fabrics',248712:'Waylaid Crate: Artisan Ingots',248713:'Waylaid Crate: Artisan Parts',
}


def main():
    raw = urllib.request.urlopen(URL, timeout=120).read()
    with tarfile.open(fileobj=io.BytesIO(raw), mode='r:gz') as tf:
        data = json.load(tf.extractfile('package/data/json/data.json'))
    out = {}
    for x in data:
        tips = ' '.join(t.get('label', '') for t in x.get('tooltip', []))
        rnd = 1 if ('Random' in tips and x.get('class') in ('Armor', 'Weapon')) else 0
        out[str(x['itemId'])] = [x['name'], QUALITY.get(x.get('quality'), 1), x.get('class', ''), x.get('subclass', ''), rnd]
    for i, n in FOREVER_EXTRA.items():
        out.setdefault(str(i), [n, 1, '', '', 0])
    with open(OUT, 'w') as f:
        json.dump(out, f, separators=(',', ':'), ensure_ascii=False)
    print(len(out), 'items written to', os.path.normpath(OUT))


if __name__ == '__main__':
    main()
