/* Forever Trades - renders data/latest.json. No dependencies. */
(function () {
  'use strict';

  const S = { data: null, faction: 'alliance', dir: 'buyNeutralSellHome', sort: 'profitDay', budget: 100000, showAll: false, open: new Set(), query: '' };
  const FAC = { alliance: 'Alliance', horde: 'Horde' };
  const CUT = { buyNeutralSellHome: '5%', buyHomeSellNeutral: '15%' };
  const PAGE = 40;
  const $ = (id) => document.getElementById(id);

  // ---------- storage (per-viewer convenience only)
  function remember(k, v) { try { localStorage.setItem('ft-' + k, v); } catch (e) { /* ignore */ } }
  function recall(k) { try { return localStorage.getItem('ft-' + k); } catch (e) { return null; } }

  // ---------- formatting
  function money(c) {
    if (c === null || c === undefined || isNaN(c)) return '–';
    const neg = c < 0; c = Math.round(Math.abs(c));
    const g = Math.floor(c / 10000), s = Math.floor(c / 100) % 100, k = c % 100;
    let out;
    if (g >= 100) out = g.toLocaleString('en') + 'g';
    else if (g) out = g + 'g ' + (s ? s + 's' : '');
    else if (c >= 1000) out = Math.round(c / 100) + 's';
    else if (s) out = s + 's ' + (k ? k + 'c' : '');
    else out = k + 'c';
    return (neg ? '−' : '') + out.trim();
  }
  function num(x, d) {
    if (x === null || x === undefined) return '–';
    if (x >= 100) return Math.round(x).toLocaleString('en');
    return (Math.round(x * Math.pow(10, d || 1)) / Math.pow(10, d || 1)).toLocaleString('en');
  }
  function mult(x) { return '×' + (x >= 10 ? Math.round(x) : x.toFixed(x >= 3 ? 1 : 2)); }
  function ago(iso) {
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    const h = Math.floor(m / 60);
    return h + ' h ' + (m % 60) + ' min ago';
  }
  function hhmm(iso) {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' (' + d.toISOString().slice(11, 16) + ' UTC)';
  }
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined) e.textContent = text;
    return e;
  }

  // ---------- data
  async function load() {
    try {
      const r = await fetch('data/latest.json?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      S.data = await r.json();
      S.loadedAt = Date.now();
      render();
    } catch (e) {
      $('fresh').textContent = 'Could not load prices (' + e.message + '). Try again in a minute.';
    }
  }
  function view() {
    const f = S.data.factions[S.faction];
    return f ? f[S.dir] : { items: [], warming: true, salesHours: 0 };
  }

  // ---------- render
  function render() {
    if (!S.data) return;
    const d = S.data, v = view(), home = FAC[S.faction];
    document.querySelectorAll('[data-faction]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.faction === S.faction)));
    document.querySelectorAll('[data-dir]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.dir === S.dir)));
    document.querySelectorAll('.home-name').forEach((n) => { n.textContent = 'sell in ' + home; });
    document.querySelectorAll('.home-name-buy').forEach((n) => { n.textContent = 'Buy in ' + home; });

    renderFresh();

    // explanation
    $('explain').textContent = S.dir === 'buyNeutralSellHome'
      ? 'These items cost less on Blackwater than they sell for in the ' + home + ' house, even after the ' + home + ' house takes its 5% cut. Buy them on Blackwater (they arrive by mail), then list them at home.'
      : 'These items cost less in the ' + home + ' house than they sell for on Blackwater, even after Blackwater takes its 15% cut. Buy them at home, then list them on Blackwater (Booty Bay, Gadgetzan or Everlook).';

    // banner while sales history builds
    const bn = $('banner');
    if (v.warming) {
      const left = Math.max(1, Math.ceil(6 - (v.salesHours || 0)));
      bn.hidden = false; bn.textContent = '';
      bn.append(el('b', null, 'Still learning what sells. '),
        'We need about 6 hours of snapshots to estimate sales; about ' + left + ' more to go. Until then this list is sorted by profit per item and shows price gaps only, so check that an item actually sells before buying many.');
    } else if ((v.salesHours || 0) < 24) {
      bn.hidden = false; bn.textContent = '';
      bn.append(el('b', null, 'Early estimates. '), 'Sales figures are based on ' + num(v.salesHours, 0) + ' hours of snapshots so far and will settle after a day or two.');
    } else {
      bn.hidden = true;
    }

    renderTiles(v);
    renderBars(v);
    renderScatter(v);
    renderBasket(v);
  }

  function renderFresh() {
    const snaps = Object.values(S.data.houses).map((h) => h.snapshot).sort();
    const oldest = snaps[0];
    const fr = $('fresh'); fr.textContent = '';
    fr.append('Prices from Blizzard’s snapshot of ', el('b', null, hhmm(oldest)), ', ' + ago(oldest) + '. Updates every hour.');
  }

  function tile(label, value, note) {
    const t = el('div', 'tile');
    t.append(el('div', 'label', label), el('div', 'value', value));
    if (note) t.append(el('div', 'note', note));
    return t;
  }

  function renderTiles(v) {
    const box = $('tiles'); box.textContent = '';
    const items = v.items;
    if (!items.length) { box.append(tile('Opportunities', '0', 'Nothing clears a ×1.15 return right now')); return; }
    if (v.warming) {
      const best = items[0];
      box.append(tile('Price gaps found', String(items.length), 'Sales data still building'),
        tile('Biggest profit per item', money(best.profitEach), best.name),
        tile('Best return', mult(Math.max.apply(null, items.map((o) => o.mult))), items.slice().sort((a, b) => b.mult - a.mult)[0].name));
      return;
    }
    const total = items.reduce((a, o) => a + (o.profitDay || 0), 0);
    const solid = items.filter((o) => o.mult >= 2).length;
    const topRet = items.slice().sort((a, b) => b.mult - a.mult)[0];
    box.append(
      tile('Profit a day if you work the whole list', money(total), items.length + ' items, ' + solid + ' at ×2 or better'),
      tile('Best item a day', money(items[0].profitDay), items[0].name),
      tile('Best return', mult(topRet.mult), topRet.name));
  }

  function sorted(v) {
    const key = v.warming && S.sort !== 'mult' ? 'profitEach' : S.sort;
    let list = v.items.slice();
    if (S.query) {
      const q = S.query.toLowerCase();
      list = list.filter((o) => o.name.toLowerCase().includes(q));
    }
    list.sort((a, b) => (b[key] || 0) - (a[key] || 0));
    return { list, key };
  }

  const KEY_LABEL = { profitDay: 'profit a day', mult: 'return', marketDay: 'market a day', profitEach: 'profit per item' };

  function renderBars(v) {
    const { list, key } = sorted(v);
    $('sort').value = key;
    const ol = $('bars'); ol.textContent = '';
    const home = FAC[S.faction];
    $('rank-title').textContent = v.items.length ? 'All ' + v.items.length + ' opportunities' : 'Opportunities';
    $('rank-sub').textContent = 'Ranked by ' + KEY_LABEL[key] + '. Bar length shows ' + KEY_LABEL[key] + '; the × figure is the return on what you pay. Tap an item for the details.';
    if (!list.length) {
      ol.append(el('li', 'empty', S.query ? 'No item matches “' + S.query + '”.' : 'No item clears a ×1.15 return right now. Check back after the next update.'));
      $('more').hidden = true;
      return;
    }
    const max = Math.max.apply(null, list.map((o) => o[key] || 0)) || 1;
    const shown = S.showAll || S.query ? list : list.slice(0, PAGE);
    shown.forEach((o, i) => {
      const li = el('li', 'bar-row');
      li.tabIndex = 0;
      li.setAttribute('role', 'button');
      li.setAttribute('aria-expanded', String(S.open.has(o.id)));
      const main = el('div', 'bar-main');
      const top = el('div', 'bar-top');
      const nm = el('span', 'bar-name');
      nm.append(el('span', 'qdot q' + (o.q || 1)), document.createTextNode(o.name));
      const figs = el('span', 'bar-figs');
      if (key === 'profitDay' && o.profitDay !== null) { figs.append(el('b', null, '+' + money(o.profitDay)), ' a day'); }
      else if (key === 'marketDay') { figs.append(el('b', null, money(o.marketDay)), ' a day'); }
      else { figs.append(el('b', null, '+' + money(o.profitEach)), ' each'); }
      top.append(nm, figs);
      const line = el('div', 'bar-line');
      const track = el('div', 'bar-track');
      const fill = el('div', 'bar-fill');
      fill.style.width = Math.max(0.6, 100 * (o[key] || 0) / max) + '%';
      track.append(fill);
      line.append(track, el('span', 'mult', mult(o.mult)));
      const chips = el('div', 'chips');
      chips.append(el('span', 'chip', 'Buy ' + money(o.buy) + ' → sell ' + money(o.sell)));
      if (o.unitsDay !== null && o.unitsDay !== undefined) chips.append(el('span', 'chip', 'move ' + num(Math.max(1, Math.floor(o.unitsDay)), 0) + ' a day'));
      if (o.trend === 'falling') chips.append(el('span', 'chip warn', 'price falling'));
      if (o.trend === 'rising') chips.append(el('span', 'chip up', 'price rising'));
      if (o.daysStock !== null && o.daysStock !== undefined && o.daysStock > 3) chips.append(el('span', 'chip', num(o.daysStock, 1) + ' days of stock listed'));
      main.append(top, line, chips, details(o, home));
      li.append(el('span', 'rank', String(i + 1)), main);
      const toggle = () => {
        if (S.open.has(o.id)) S.open.delete(o.id); else S.open.add(o.id);
        li.setAttribute('aria-expanded', String(S.open.has(o.id)));
      };
      li.addEventListener('click', (e) => { if (!e.target.closest('a')) toggle(); });
      li.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      ol.append(li);
    });
    const more = $('more');
    if (!S.query && list.length > PAGE) {
      more.hidden = false;
      more.textContent = S.showAll ? 'Show the top ' + PAGE + ' only' : 'Show all ' + list.length + ' items';
    } else more.hidden = true;
  }

  function details(o, home) {
    const box = el('div', 'details');
    const dl = el('dl');
    const src = S.dir === 'buyNeutralSellHome' ? 'Blackwater' : home;
    const dst = S.dir === 'buyNeutralSellHome' ? home : 'Blackwater';
    const rows = [
      ['Buy at (' + src + ')', money(o.buy) + (o.low !== o.buy ? ' avg, from ' + money(o.low) : '')],
      ['Listed on ' + src, num(o.srcQty, 0)],
      ['Sell at (' + dst + ')', money(o.sell)],
      ['You get back (after ' + CUT[S.dir] + ' cut)', money(o.back)],
      ['Profit per item', money(o.profitEach)],
      ['Return', mult(o.mult) + ' · ' + o.tag],
      ['Sells a day on ' + dst, o.soldDay === null ? 'collecting…' : num(o.soldDay, 1)],
      ['Your share a day', o.unitsDay === null ? '–' : (o.unitsDay < 1 ? 'about 1 every ' + num(1 / o.unitsDay, 1) + ' days' : num(o.unitsDay, 1))],
      ['Profit a day', o.profitDay === null ? '–' : money(o.profitDay)],
      ['Listed on ' + dst, num(o.dstQty, 0)],
      ['7-day typical on ' + dst, o.dstTyp ? money(o.dstTyp) : 'building'],
      ['Gold traded a day', o.marketDay ? money(o.marketDay) : '–'],
    ];
    rows.forEach(([k, val]) => { const kv = el('div', 'kv'); kv.append(el('dt', null, k), el('dd', null, val)); dl.append(kv); });
    box.append(dl);
    const n = o.unitsDay ? Math.max(1, Math.floor(o.unitsDay)) : 1;
    box.append(el('p', 'how', 'Today: buy up to ' + n + ' on ' + src + ' at ' + money(o.buy) + ' or less, and list on ' + dst + ' at about ' + money(o.sell) + '.'));
    return box;
  }

  // ---------- scatter: return vs market size (all items, log-log)
  function renderScatter(v) {
    const card = $('scatter-card');
    const pts = v.items.filter((o) => o.marketDay > 0);
    if (v.warming || pts.length < 3) {
      card.hidden = !v.warming ? pts.length < 3 : false;
      const svg = $('scatter'); svg.textContent = '';
      if (v.warming) {
        svg.setAttribute('viewBox', '0 0 600 60');
        const t = document.createElementNS('http://www.w3.org/2000/svg', 'text');
        t.setAttribute('x', 0); t.setAttribute('y', 30); t.setAttribute('class', 'lab'); t.textContent = 'Appears once we have about 6 hours of sales data.';
        svg.append(t);
      }
      return;
    }
    card.hidden = false;
    const wrap = $('scatter-wrap');
    const W = Math.max(320, Math.min(940, wrap.clientWidth || 600));
    const H = Math.round(W < 500 ? W * 0.95 : W * 0.55);
    const m = { l: 46, r: 14, t: 12, b: 40 };
    const svg = $('scatter'); svg.textContent = '';
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    const NS = 'http://www.w3.org/2000/svg';
    const mk = (tag, attrs, cls) => { const e = document.createElementNS(NS, tag); for (const k in attrs) e.setAttribute(k, attrs[k]); if (cls) e.setAttribute('class', cls); return e; };
    const xs = pts.map((o) => Math.log10(o.marketDay)), ys = pts.map((o) => Math.log10(o.mult));
    let x0 = Math.floor(Math.min.apply(null, xs)), x1 = Math.ceil(Math.max.apply(null, xs));
    if (x1 === x0) x1 = x0 + 1;
    const y0 = Math.log10(1.1), y1 = Math.max(Math.log10(2.5), Math.max.apply(null, ys) + 0.05);
    const X = (lv) => m.l + (lv - x0) / (x1 - x0) * (W - m.l - m.r);
    const Y = (lv) => H - m.b - (lv - y0) / (y1 - y0) * (H - m.t - m.b);
    const grid = mk('g', {}, 'grid'), axis = mk('g', {}, 'axis');
    for (let e = x0; e <= x1; e++) {
      grid.append(mk('line', { x1: X(e), x2: X(e), y1: m.t, y2: H - m.b }));
      const t = mk('text', { x: X(e), y: H - m.b + 16, 'text-anchor': 'middle' }); t.textContent = money(Math.pow(10, e)); axis.append(t);
    }
    [1.15, 1.5, 2, 3, 5, 10, 20, 50, 100].filter((y) => Math.log10(y) <= y1 && Math.log10(y) >= y0).forEach((y) => {
      grid.append(mk('line', { x1: m.l, x2: W - m.r, y1: Y(Math.log10(y)), y2: Y(Math.log10(y)) }));
      const t = mk('text', { x: m.l - 6, y: Y(Math.log10(y)) + 4, 'text-anchor': 'end' }); t.textContent = '×' + y; axis.append(t);
    });
    const xt = mk('text', { x: (m.l + W - m.r) / 2, y: H - 6, 'text-anchor': 'middle' }, 'axis-title'); xt.textContent = 'Gold traded a day on the house you sell on (log scale)';
    const yt = mk('text', { x: 12, y: (m.t + H - m.b) / 2, transform: 'rotate(-90 12 ' + ((m.t + H - m.b) / 2) + ')', 'text-anchor': 'middle' }, 'axis-title'); yt.textContent = 'Return (×)';
    svg.append(grid, axis, xt, yt);
    const dots = mk('g');
    const tip = $('tooltip');
    pts.forEach((o) => {
      const cx = X(Math.log10(o.marketDay)), cy = Y(Math.log10(o.mult));
      const hit = mk('circle', { cx, cy, r: 12, tabindex: 0, 'aria-label': o.name + ', ' + mult(o.mult) + ', ' + money(o.marketDay) + ' a day' }, 'hit');
      const dot = mk('circle', { cx, cy, r: 5 }, 'dot');
      const show = (ev) => {
        dot.classList.add('on');
        tip.textContent = '';
        tip.append(el('div', 'tv', mult(o.mult) + ' · +' + money(o.profitDay) + ' a day'), el('div', 'tn', o.name));
        [['Buy', money(o.buy)], ['Sell', money(o.sell)], ['Sells a day', num(o.soldDay, 1)], ['Gold traded a day', money(o.marketDay)]].forEach(([a, b]) => {
          const r = el('div', 'tr'); r.append(el('span', null, a), el('span', null, b)); tip.append(r);
        });
        tip.hidden = false;
        const bb = hit.getBoundingClientRect();
        const tw = tip.offsetWidth, th = tip.offsetHeight;
        let lx = bb.left + bb.width / 2 + 12, ly = bb.top - th - 6;
        if (lx + tw > window.innerWidth - 8) lx = bb.left - tw - 6;
        if (ly < 8) ly = bb.bottom + 6;
        tip.style.left = Math.max(8, lx) + 'px'; tip.style.top = ly + 'px';
      };
      const hide = () => { dot.classList.remove('on'); tip.hidden = true; };
      hit.addEventListener('pointerenter', show); hit.addEventListener('pointerleave', hide);
      hit.addEventListener('focus', show); hit.addEventListener('blur', hide);
      hit.addEventListener('click', (e) => { e.stopPropagation(); show(e); });
      dots.append(hit, dot);
    });
    svg.append(dots);
    // direct labels: top items by profit a day, skipping any that would collide
    const labels = mk('g'); const boxes = [];
    const top = pts.slice().sort((a, b) => (b.profitDay || 0) - (a.profitDay || 0)).slice(0, W < 500 ? 8 : 16);
    top.forEach((o) => {
      const cx = X(Math.log10(o.marketDay)), cy = Y(Math.log10(o.mult));
      const name = o.name.length > 24 ? o.name.slice(0, 23) + '…' : o.name;
      const w = name.length * 6.1 + 6, h = 14;
      const cands = [[cx + 8, cy - 4], [cx - 8 - w, cy - 4], [cx - w / 2, cy - 12], [cx - w / 2, cy + 18]];
      for (const [lx, ly] of cands) {
        const b = { x: lx, y: ly - 11, w, h };
        if (b.x < m.l || b.x + b.w > W - m.r || b.y < 0 || b.y + b.h > H - m.b) continue;
        if (boxes.some((q) => b.x < q.x + q.w && b.x + b.w > q.x && b.y < q.y + q.h && b.y + b.h > q.y)) continue;
        boxes.push(b);
        labels.append(mk('rect', { x: b.x - 2, y: b.y, width: b.w, height: b.h, rx: 3 }, 'lab-bg'));
        const t = mk('text', { x: lx + 1, y: ly }, 'lab'); t.textContent = name; labels.append(t);
        break;
      }
    });
    svg.append(labels);
  }

  // ---------- shopping list
  function basket(v, budget) {
    const lines = [];
    let left = budget;
    const cands = v.items.filter((o) => o.soldDay !== null && o.soldDay >= 1).sort((a, b) => b.mult - a.mult);
    for (const o of cands) {
      let cap = Math.floor(o.unitsDay || 0);
      if (cap < 1 && o.soldDay >= 2) cap = 1;
      if (cap < 1) continue;
      let units = 0, cost = 0, maxP = 0;
      for (const [p, q] of o.ladder) {
        if (o.back / p < 1.15) break;
        const take = Math.min(q, cap - units, Math.floor(left / p));
        if (take <= 0) break;
        units += take; cost += take * p; left -= take * p; maxP = p;
        if (units >= cap) break;
      }
      if (!units) continue;
      const back = units * o.back;
      if (back - cost < 300) { left += cost; continue; }
      lines.push({ o, units, cost, back, maxP });
      if (left < 50) break;
    }
    return { lines, spend: budget - left, back: lines.reduce((a, l) => a + l.back, 0) };
  }

  function renderBasket(v) {
    const box = $('basket'); box.textContent = '';
    if (v.warming) { box.append(el('p', 'empty', 'Ready once we have about 6 hours of sales data, so the list only includes items that actually sell.')); return; }
    const b = basket(v, S.budget);
    if (!b.lines.length) { box.append(el('p', 'empty', 'Nothing fits this budget with a safe return right now.')); return; }
    const home = FAC[S.faction];
    const src = S.dir === 'buyNeutralSellHome' ? 'Blackwater' : home;
    const dst = S.dir === 'buyNeutralSellHome' ? home : 'Blackwater';
    const tot = el('div', 'basket-total');
    const profit = b.back - b.spend;
    const add = (label, val) => { const s = el('span'); s.append(label + ' ', el('b', null, val)); tot.append(s); };
    add('Spend on ' + src + ':', money(b.spend));
    add('Get back on ' + dst + ':', money(b.back));
    add('Profit:', '+' + money(profit) + ' (' + mult(b.back / b.spend) + ')');
    box.append(tot);
    const t = el('table', 'basket-table');
    const hr = el('tr');
    [['Item', ''], ['How many', 'num'], ['Pay up to', 'num hide-s'], ['Total cost', 'num'], ['List at', 'num hide-s'], ['Profit', 'num']].forEach(([h, c]) => hr.append(el('th', c, h)));
    const thead = el('thead'); thead.append(hr); t.append(thead);
    const tb = el('tbody');
    b.lines.slice().sort((x, y) => (y.back - y.cost) - (x.back - x.cost)).forEach((l) => {
      const tr = el('tr');
      tr.append(el('td', null, l.o.name), el('td', 'num', String(l.units)), el('td', 'num hide-s', money(l.maxP)),
        el('td', 'num', money(l.cost)), el('td', 'num hide-s', money(l.o.sell)), el('td', 'num', '+' + money(l.back - l.cost)));
      tb.append(tr);
    });
    t.append(tb); box.append(t);
    const btn = el('button', 'copy', 'Copy the list');
    btn.type = 'button';
    btn.addEventListener('click', () => {
      const txt = b.lines.map((l) => l.units + ' × ' + l.o.name + ' (pay up to ' + money(l.maxP) + ' each, list at ' + money(l.o.sell) + ')').join('\n');
      const done = () => { btn.textContent = 'Copied'; setTimeout(() => { btn.textContent = 'Copy the list'; }, 1500); };
      if (navigator.clipboard) navigator.clipboard.writeText(txt).then(done, () => { btn.textContent = 'Copy failed'; });
    });
    box.append(btn);
  }

  // ---------- events
  document.querySelectorAll('[data-faction]').forEach((b) => b.addEventListener('click', () => {
    S.faction = b.dataset.faction; remember('faction', S.faction); S.showAll = false; S.open.clear(); render();
  }));
  document.querySelectorAll('[data-dir]').forEach((b) => b.addEventListener('click', () => {
    S.dir = b.dataset.dir; remember('dir', S.dir); S.showAll = false; S.open.clear(); render();
  }));
  $('sort').addEventListener('change', (e) => { S.sort = e.target.value; render(); });
  $('budget').addEventListener('change', (e) => { S.budget = Number(e.target.value); remember('budget', S.budget); render(); });
  $('more').addEventListener('click', () => { S.showAll = !S.showAll; render(); });
  $('search').addEventListener('input', (e) => { S.query = e.target.value.trim(); renderBars(view()); });
  document.addEventListener('click', () => { $('tooltip').hidden = true; });
  let rt; window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => S.data && renderScatter(view()), 150); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.loadedAt && Date.now() - S.loadedAt > 10 * 60000) load(); });
  setInterval(() => { if (S.data) renderFresh(); }, 60000);

  // restore
  const f = recall('faction'); if (f && FAC[f]) S.faction = f;
  const d = recall('dir'); if (d === 'buyNeutralSellHome' || d === 'buyHomeSellNeutral') S.dir = d;
  const bg = Number(recall('budget')); if (bg) { S.budget = bg; $('budget').value = String(bg); }
  load();
})();
