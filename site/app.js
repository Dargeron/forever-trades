/* Forever Trades - renders data/latest.json. No dependencies. */
(function () {
  'use strict';

  const S = {
    data: null, faction: 'alliance', dir: 'buyNeutralSellHome', sort: 'profitDay', budget: 100000,
    sortDir: 'desc', showAll: false, open: new Set(), query: '',
    busySort: 'marketDay', busyDir: 'desc', busyAll: false, busyQuery: '', chartQuery: '',
  };
  const FAC = { alliance: 'Alliance', horde: 'Horde' };
  const OTHER = { alliance: 'Horde', horde: 'Alliance' };
  const VERSION = 'dev';   // stamped with the commit at deploy time (see update.yml)
  const PAGE = 40, BUSY_PAGE = 25;
  const SORTS = { profitDay: 'Profit a day', mult: 'Back per 1g (×)', marketDay: 'Market a day', soldDay: 'Sold a day', profitEach: 'Profit per item', buy: 'Buy price', sell: 'Sell price', name: 'Name' };
  const KEY_LABEL = { profitDay: 'profit a day', mult: 'back per 1g', marketDay: 'market a day', soldDay: 'sold a day', profitEach: 'profit per item', buy: 'buy price', sell: 'sell price', name: 'name' };
  const ALWAYS = { mult: 1, profitEach: 1, buy: 1, sell: 1, name: 1 };
  const BUSY_KEYS = { name: 1, soldDay: 1, avg: 1, marketDay: 1, resellX: 1, low: 1, aLow: 1, hLow: 1 };
  const $ = (id) => document.getElementById(id);
  const NS = 'http://www.w3.org/2000/svg';

  // ---------- storage (per-viewer convenience only)
  function remember(k, v) { try { localStorage.setItem('ft-' + k, v); } catch (e) { /* ignore */ } }
  function recall(k) { try { return localStorage.getItem('ft-' + k); } catch (e) { return null; } }

  // ---------- formatting
  function el(tag, cls, text) {
    const e = document.createElement(tag);
    if (cls) e.className = cls;
    if (text !== undefined && text !== null) e.textContent = text;
    return e;
  }
  function parts(c) {
    c = Math.round(Math.abs(c));
    const g = Math.floor(c / 10000), s = Math.floor(c / 100) % 100, k = c % 100;
    if (g >= 100) return [[g.toLocaleString('en'), 'g']];
    if (g) return s ? [[g, 'g'], [s, 's']] : [[g, 'g']];
    if (c >= 1000) return [[Math.round(c / 100), 's']];
    if (s) return k ? [[s, 's'], [k, 'c']] : [[s, 's']];
    return [[k, 'c']];
  }
  function bad(c) { return c === null || c === undefined || isNaN(c); }
  function money(c) { return bad(c) ? '–' : (c < 0 ? '−' : '') + parts(c).map(([n, u]) => n + u).join(' '); }
  function coins(c, plus) {
    const span = el('span', 'money');
    if (bad(c)) { span.textContent = '–'; return span; }
    if (c < 0) span.append('−'); else if (plus) span.append('+');
    parts(c).forEach(([n, u], i) => { if (i) span.append(' '); span.append(String(n), el('span', 'u' + u, u)); });
    return span;
  }
  function num(x, d) {
    if (bad(x)) return '–';
    if (x >= 100) return Math.round(x).toLocaleString('en');
    const f = Math.pow(10, d === undefined ? 1 : d);
    return (Math.round(x * f) / f).toLocaleString('en');
  }
  function mult(x) { return bad(x) ? '–' : '×' + (x >= 10 ? Math.round(x).toLocaleString('en') : x.toFixed(x >= 3 ? 1 : 2)); }
  function ago(iso) {
    const m = Math.round((Date.now() - new Date(iso).getTime()) / 60000);
    if (m < 1) return 'just now';
    if (m < 60) return m + ' min ago';
    return Math.floor(m / 60) + ' h ' + (m % 60) + ' min ago';
  }
  function hhmm(iso) {
    const d = new Date(iso);
    return d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) + ' (' + d.toISOString().slice(11, 16) + ' UTC)';
  }
  function itemName(o, extra) { return el('span', 'iname q' + (o.q === undefined || o.q === null ? 1 : o.q) + (extra ? ' ' + extra : ''), o.name); }
  function join() { const s = el('span'); s.append.apply(s, arguments); return s; }
  function soldTxt(o) { return o.soldDay === null || o.soldDay === undefined ? 'collecting…' : (o.soldDay === 0 ? 'none yet' : num(o.soldDay, 1)); }
  function shareTxt(o) { return o.unitsDay === null || o.unitsDay === undefined ? '–' : (o.unitsDay < 1 ? 'about 1 every ' + num(1 / o.unitsDay, 1) + ' days' : num(o.unitsDay, 1)); }
  function shade(td, x, lo, hi) {
    const a = x > 0 ? Math.max(0, Math.min(1, (Math.log10(x) - lo) / (hi - lo))) : 0;
    td.style.setProperty('--a', (0.06 + 0.5 * a).toFixed(3));
  }

  // ---------- data
  async function load() {
    try {
      const r = await fetch('data/latest.json?t=' + Date.now(), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      S.data = await r.json();
      // A browser may keep an older copy of this page and script for a while (GitHub Pages caches
      // them for 10 minutes; apps longer), but the data is always fresh. If the data belongs to a
      // newer deploy, load the matching page once instead of misreading the new data.
      const want = S.data.siteVersion;
      if (want && want !== 'dev' && VERSION !== 'dev' && want !== VERSION && location.search.indexOf('v=' + want) < 0) {
        location.replace(location.pathname + '?v=' + want + location.hash);
        return;
      }
      S.loadedAt = Date.now();
      render();
    } catch (e) {
      $('fresh').textContent = 'Could not load prices (' + e.message + '). Try again in a minute.';
    }
  }
  function view() {
    const f = S.data.factions[S.faction];
    return (f && f[S.dir]) || { items: [], warming: true, salesHours: 0 };
  }
  const toBW = () => S.dir === 'buyHomeSellNeutral';
  function hasKey(v, key) { return !!ALWAYS[key] || v.items.some((o) => o[key] > 0); }

  // ---------- render
  function render() {
    if (!S.data) return;
    const v = view(), home = FAC[S.faction], other = OTHER[S.faction];
    document.documentElement.dataset.faction = S.faction;
    document.querySelectorAll('[data-faction]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.faction === S.faction)));
    document.querySelectorAll('[data-dir]').forEach((b) => b.setAttribute('aria-checked', String(b.dataset.dir === S.dir)));
    document.querySelectorAll('.home-name').forEach((n) => { n.textContent = 'sell in ' + home; });
    document.querySelectorAll('.home-name-buy').forEach((n) => { n.textContent = 'Buy in ' + home; });
    renderFresh();
    $('explain').textContent = toBW()
      ? 'These items are cheap in the ' + home + ' house and dear in the ' + other + ' house. On Blackwater your buyers are ' + other + ' traders who resell at home, so we price each item at half the ' + other + ' price (they need a profit too), or at the cheapest Blackwater listing if someone already sells for less. Blackwater’s own asking prices are ignored: they are often far too high. Buy at home, then list on Blackwater (Booty Bay, Gadgetzan or Everlook); its 15% cut is already taken off.'
      : 'These items cost less on Blackwater than they sell for in the ' + home + ' house, even after the ' + home + ' house takes its 5% cut. Buy them on Blackwater (they arrive by mail), then list them at home.';
    renderBanner(v);
    const bask = basket(v, S.budget);
    renderTiles(v);
    renderTable(v);
    renderScatter(v, bask);
    renderTop10(v);
    renderBasket(v, bask);
    renderBusy();
  }

  function renderFresh() {
    const snaps = Object.values(S.data.houses).map((h) => h.snapshot).sort();
    const oldest = snaps[0];
    const fr = $('fresh'); fr.textContent = '';
    fr.append('Prices from Blizzard’s snapshot of ', el('b', null, hhmm(oldest)), ', ' + ago(oldest) + '. Updates every hour.');
  }

  function renderBanner(v) {
    const bn = $('banner'), h = v.salesHours || 0;
    bn.textContent = '';
    bn.hidden = false;
    if (h < 1) {
      bn.append(el('b', null, 'Still learning what sells. '), 'Sales are worked out by comparing hourly snapshots, so sales figures, market sizes and the chart start after the next hourly update. Until then this is a list of price gaps: check that an item actually sells before buying many.');
    } else if (v.warming) {
      bn.append(el('b', null, 'Early estimates (' + num(h, 0) + (h < 1.5 ? ' hour' : ' hours') + ' of data). '), 'Sales figures are rough for now, and items with no sale seen yet are still listed (“none yet”). From about 6 hours on, only items that actually sell are kept.');
    } else if (h < 24) {
      bn.append(el('b', null, 'Early estimates. '), 'Sales figures are based on ' + num(h, 0) + ' hours of snapshots so far and will settle after a day or two.');
    } else {
      bn.hidden = true;
    }
  }

  function tile(label, value, note) {
    const t = el('div', 'tile');
    t.append(el('div', 'label', label));
    const val = el('div', 'value'); val.append(value); t.append(val);
    if (note && typeof note === 'object') { const n = el('div', 'note'); n.append(itemName(note)); t.append(n); } else if (note) t.append(el('div', 'note', note));
    return t;
  }

  function renderTiles(v) {
    const box = $('tiles'); box.textContent = '';
    const items = v.items;
    if (!items.length) { box.append(tile('Opportunities', '0', 'Nothing clears a ×1.15 return right now')); return; }
    const topRet = items.reduce((a, o) => (o.mult > a.mult ? o : a));
    const withDay = items.filter((o) => o.profitDay > 0);
    if (!withDay.length) {
      const best = items.reduce((a, o) => (o.profitEach > a.profitEach ? o : a));
      box.append(tile('Price gaps found', String(items.length), 'Sales data still building'),
        tile('Biggest profit per item', coins(best.profitEach, true), best), tile('Best return', mult(topRet.mult), topRet));
      return;
    }
    const total = withDay.reduce((a, o) => a + o.profitDay, 0);
    const best = withDay.reduce((a, o) => (o.profitDay > a.profitDay ? o : a));
    const solid = withDay.filter((o) => o.mult >= 2).length;
    box.append(
      tile('Profit a day, working the whole list', coins(total, true), withDay.length + ' items seen selling' + (withDay.length < items.length ? ' (of ' + items.length + ')' : '') + ', ' + solid + ' at ×2 or better'),
      tile('Best item a day', coins(best.profitDay, true), best),
      tile('Best return', mult(topRet.mult), topRet));
  }

  // ---------- sorting: the drop-down and the column headings
  function defaultDir(key) { return key === 'name' ? 'asc' : 'desc'; }
  function sortList(list, key, dir, tie) {
    const sign = dir === 'asc' ? 1 : -1;
    if (key === 'name') return list.sort((a, b) => sign * a.name.localeCompare(b.name));
    const missing = (x) => x === null || x === undefined || Number.isNaN(x);
    return list.sort((a, b) => {
      const x = a[key], y = b[key];
      if (missing(x) || missing(y)) return missing(x) === missing(y) ? tie(a, b) : (missing(x) ? 1 : -1);
      return sign * (x - y) || tie(a, b);
    });
  }
  function markHeaders(scope, key, dir) {
    scope.querySelectorAll('th[data-sort]').forEach((th) => {
      const on = th.dataset.sort === key;
      th.setAttribute('aria-sort', on ? (dir === 'asc' ? 'ascending' : 'descending') : 'none');
      const arrow = th.querySelector('.th-arrow');
      if (arrow) arrow.textContent = on ? (dir === 'asc' ? '▲' : '▼') : '↕';
    });
  }

  // ---------- ranked table
  function sorted(v) {
    const key = hasKey(v, S.sort) ? S.sort : 'profitEach';
    const dir = key === S.sort ? S.sortDir : 'desc';
    let list = v.items.slice();
    if (S.query) { const q = S.query.toLowerCase(); list = list.filter((o) => o.name.toLowerCase().includes(q)); }
    sortList(list, key, dir, (a, b) => b.profitEach - a.profitEach);
    return { list, key, dir };
  }

  function updateSortOptions(v) {
    Array.prototype.forEach.call($('sort').options, (op) => {
      const ok = hasKey(v, op.value);
      op.disabled = !ok;
      op.textContent = SORTS[op.value] + (ok ? '' : ' (after the first hourly update)');
    });
  }

  function barCell(o, key, max) {
    const td = el('td', 'c-bar');
    const val = el('span', 'val');
    const x = o[key];
    if (bad(x) || !x) {
      if (key === 'profitDay') val.append(el('span', 'muted', '+' + money(o.profitEach) + ' each'));
      else val.append(el('span', 'muted', '–'));
    } else val.append(coins(x, key !== 'marketDay'), el('span', 'per', key === 'profitEach' ? ' each' : ' a day'));
    const track = el('span', 'track'), fill = el('span', 'fill');
    fill.style.width = (x > 0 ? Math.max(1.5, Math.min(100, 100 * x / max)) : 0) + '%';
    track.append(fill); td.append(val, track);
    return td;
  }

  function numTd(content, cls) { const td = el('td', 'num' + (cls ? ' ' + cls : '')); td.append(content); return td; }

  function renderTable(v) {
    updateSortOptions(v);
    const { list, key, dir } = sorted(v);
    $('sort').value = key;
    const other = OTHER[S.faction];
    const barKey = key === 'profitEach' || !hasKey(v, 'profitDay') ? 'profitEach' : 'profitDay';
    const thb = $('th-bar');
    thb.dataset.sort = barKey;
    thb.querySelector('.th-label').textContent = barKey === 'profitEach' ? 'Profit per item' : 'Profit a day';
    markHeaders($('rank-card'), key, dir);
    $('rank-title').textContent = v.items.length ? 'All ' + v.items.length + ' opportunities' : 'Opportunities';
    const order = key === 'name' ? (dir === 'asc' ? 'A to Z' : 'Z to A') : (dir === 'asc' ? 'lowest first' : 'highest first');
    $('rank-sub').textContent = 'Sorted by ' + KEY_LABEL[key] + ', ' + order + '. Tap a column heading to sort by it (again to flip), or a row for the details. Shading: darker means a bigger return or a bigger market.';
    const tb = $('rank-body'); tb.textContent = '';
    if (!list.length) {
      const tr = el('tr'), td = el('td', 'empty', S.query ? 'No item matches “' + S.query + '”.' : 'No item clears a ×1.15 return right now. Check back after the next update.');
      td.colSpan = 8; tr.append(td); tb.append(tr); $('more').hidden = true; return;
    }
    const max = Math.max.apply(null, list.map((o) => o[barKey] || 0)) || 1;
    const shown = S.showAll || S.query ? list : list.slice(0, PAGE);
    shown.forEach((o, i) => {
      const tr = el('tr', 'row');
      tr.tabIndex = 0;
      tr.setAttribute('aria-expanded', String(S.open.has(o.id)));
      tr.append(el('td', 'c-rank', String(i + 1)));
      const ti = el('td', 'c-item');
      ti.append(itemName(o));
      const sub = el('span', 'item-sub');
      const bs = el('span', 'flag only-s'); bs.append(coins(o.buy), ' → ', coins(o.sell)); sub.append(bs);
      if (toBW()) sub.append(el('span', 'flag', o.undercut ? 'matches Blackwater' : '½ of ' + other + ' ' + money(o.ref)));
      if (o.soldDay === 0) sub.append(el('span', 'flag', 'none sold yet'));
      if (o.trend === 'falling') sub.append(el('span', 'flag warn', (toBW() ? other + ' ' : '') + 'price falling'));
      if (o.trend === 'rising') sub.append(el('span', 'flag up', (toBW() ? other + ' ' : '') + 'price rising'));
      ti.append(sub);
      tr.append(ti, numTd(coins(o.buy), 'hide-s'), numTd(coins(o.sell), 'hide-s'));
      const tdr = numTd(mult(o.mult), 'ret c-ret'); shade(tdr, o.mult, Math.log10(1.15), Math.log10(30)); tr.append(tdr);
      const tdm = numTd(o.marketDay ? coins(o.marketDay) : '–', 'mkt hide-s'); if (o.marketDay) shade(tdm, o.marketDay, 4, 6.7); tr.append(tdm);
      tr.append(numTd(soldTxt(o), 'hide-m'), barCell(o, barKey, max));
      const dr = el('tr', 'details-row');
      dr.hidden = !S.open.has(o.id);
      const dtd = el('td'); dtd.colSpan = 8; dtd.append(details(o)); dr.append(dtd);
      const toggle = () => {
        if (S.open.has(o.id)) S.open.delete(o.id); else S.open.add(o.id);
        const on = S.open.has(o.id);
        tr.setAttribute('aria-expanded', String(on)); dr.hidden = !on;
      };
      tr.addEventListener('click', toggle);
      tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
      tb.append(tr, dr);
    });
    const more = $('more');
    if (!S.query && list.length > PAGE) {
      more.hidden = false;
      more.textContent = S.showAll ? 'Show the top ' + PAGE + ' only' : 'Show all ' + list.length + ' items';
    } else more.hidden = true;
  }

  function details(o) {
    const home = FAC[S.faction], other = OTHER[S.faction];
    const box = el('div', 'details');
    const dl = el('dl');
    const buyNode = join(coins(o.buy), o.low !== o.buy ? join(' avg, from ', coins(o.low)) : '');
    const sh = Math.round(100 * (view().share || 0.5));
    const spend = o.unitsDay ? coins(Math.max(1, Math.floor(o.unitsDay)) * o.buy) : '–';
    const rows = toBW() ? [
      ['Buy at (' + home + ')', buyNode],
      ['Listed in ' + home, num(o.srcQty, 0)],
      [other + ' price', join(coins(o.ref), o.refLow !== null && o.ref < o.refLow ? ' (7-day typical; cheapest now ' + money(o.refLow) + ')' : '')],
      [(sh === 50 ? 'Half' : sh + '%') + ' of that', coins(o.half)],
      ['Cheapest on Blackwater', o.dstLow === null ? 'none listed' : join(coins(o.dstLow), o.undercut ? ' (competition: matched)' : ' (ignored: too high)')],
      ['Sell at (Blackwater)', join(coins(o.sell), o.undercut ? ', matching Blackwater' : ', ' + (sh === 50 ? 'half' : sh + '% of') + ' the ' + other + ' price')],
      ['You get back (after 15% cut)', coins(o.back)],
      ['Profit per item', coins(o.profitEach, true)],
      ['Return', mult(o.mult) + ' · ' + o.tag],
      ['Sold a day in the ' + other + ' house', soldTxt(o)],
      ['Your share a day', shareTxt(o)],
      ['Spend a day', spend],
      ['Profit a day', o.profitDay ? coins(o.profitDay, true) : '–'],
      ['Listed in the ' + other + ' house', num(o.refQty, 0)],
      ['Gold a day in the ' + other + ' house', o.marketDay ? coins(o.marketDay) : '–'],
    ] : [
      ['Buy at (Blackwater)', buyNode],
      ['Listed on Blackwater', num(o.srcQty, 0)],
      ['Sell at (' + home + ')', coins(o.sell)],
      ['You get back (after 5% cut)', coins(o.back)],
      ['Profit per item', coins(o.profitEach, true)],
      ['Return', mult(o.mult) + ' · ' + o.tag],
      ['Sold a day in the ' + home + ' house', soldTxt(o)],
      ['Your share a day', shareTxt(o)],
      ['Spend a day', spend],
      ['Profit a day', o.profitDay ? coins(o.profitDay, true) : '–'],
      ['Listed in the ' + home + ' house', num(o.dstQty, 0)],
      ['7-day typical in the ' + home + ' house', o.dstTyp ? coins(o.dstTyp) : 'building'],
      ['Gold a day in the ' + home + ' house', o.marketDay ? coins(o.marketDay) : '–'],
    ];
    rows.forEach(([k, val]) => { const kv = el('div', 'kv'), dd = el('dd'); dd.append(val); kv.append(el('dt', null, k), dd); dl.append(kv); });
    box.append(dl);
    const n = o.unitsDay ? Math.max(1, Math.floor(o.unitsDay)) : 1;
    const how = el('p', 'how');
    how.append('Today: buy up to ' + n + (toBW() ? ' in the ' + home + ' house' : ' on Blackwater') + ' at ', coins(o.buy),
      ' or less, and list ' + (toBW() ? 'on Blackwater' : 'in the ' + home + ' house') + ' at about ', coins(o.sell), '.');
    box.append(how);
    return box;
  }

  // ---------- chart: return against market size (log-log), every item with sales
  function svgEl(tag, attrs, cls) {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) e.setAttribute(k, attrs[k]);
    if (cls) e.setAttribute('class', cls);
    return e;
  }

  function showTip(o, anchor) {
    const tip = $('tooltip'), other = OTHER[S.faction];
    tip.textContent = '';
    tip.append(el('div', 'tn tq' + (o.q === undefined ? 1 : o.q), o.name), el('div', 'tsub', mult(o.mult) + ' back per 1g · ' + o.tag));
    const rows = [['Buy', coins(o.buy)]];
    if (toBW()) rows.push([other + ' price', coins(o.ref)]);
    rows.push(['Sell', coins(o.sell)], ['Profit a day', o.profitDay ? coins(o.profitDay, true) : '–'], ['Sold a day', soldTxt(o)], ['Market a day', coins(o.marketDay)]);
    rows.forEach(([a, b]) => { const r = el('div', 'tr'), vb = el('span'); vb.append(b); r.append(el('span', null, a), vb); tip.append(r); });
    tip.hidden = false;
    const bb = anchor.getBoundingClientRect(), tw = tip.offsetWidth, th = tip.offsetHeight;
    let lx = bb.left + bb.width / 2 + 14, ly = bb.top - th - 8;
    if (lx + tw > window.innerWidth - 8) lx = bb.left - tw - 8;
    if (ly < 8) ly = bb.bottom + 8;
    tip.style.left = Math.max(8, lx) + 'px';
    tip.style.top = Math.max(8, Math.min(ly, window.innerHeight - th - 8)) + 'px';
  }

  function renderScatter(v, bask) {
    const svg = $('scatter'), empty = $('scatter-empty'), legend = $('legend');
    const all = v.items.filter((o) => o.marketDay > 0 && o.mult > 0);
    const q = S.chartQuery.toLowerCase();
    const pts = q ? all.filter((o) => o.name.toLowerCase().includes(q)) : all;
    $('chart-count').textContent = !all.length ? '' : (q ? 'Showing ' + pts.length + ' of ' + all.length + ' items' : all.length + ' items');
    svg.textContent = '';
    if (!pts.length || (!q && pts.length < 2)) {
      svg.style.display = 'none'; legend.hidden = true; empty.hidden = false;
      empty.textContent = !all.length || (!q && all.length < 2)
        ? ((v.salesHours || 0) < 1 ? 'The chart appears after the next hourly update, once we have seen what sells.' : 'Not enough items seen selling yet. Check back after the next update.')
        : 'No item on the chart contains “' + S.chartQuery + '”.';
      return;
    }
    svg.style.display = ''; legend.hidden = false; empty.hidden = true;
    const W = Math.max(300, Math.min(1000, $('scatter-wrap').clientWidth || 600));
    const narrow = W < 560;
    const H = Math.round(narrow ? W * 1.05 : W * 0.56);
    const m = { l: narrow ? 42 : 54, r: 14, t: 14, b: 46 };
    svg.setAttribute('viewBox', '0 0 ' + W + ' ' + H);
    const xs = pts.map((o) => Math.log10(o.marketDay)), ys = pts.map((o) => Math.log10(o.mult));
    let x0 = Math.min.apply(null, xs) - 0.12, x1 = Math.max.apply(null, xs) + 0.12;
    if (x1 - x0 < 1.2) { const mid = (x0 + x1) / 2; x0 = mid - 0.6; x1 = mid + 0.6; }   // a few dots: keep a 10x-plus span of gold ticks
    const y0 = Math.log10(1.1), y1 = Math.max(Math.log10(3), Math.max.apply(null, ys) + 0.08);
    const X = (lv) => m.l + (lv - x0) / (x1 - x0) * (W - m.l - m.r);
    const Y = (lv) => H - m.b - (lv - y0) / (y1 - y0) * (H - m.t - m.b);
    const grid = svgEl('g', {}, 'gridl'), axis = svgEl('g', {}, 'axis');
    let xt = [];
    for (let e = Math.floor(x0); e <= Math.ceil(x1); e++) [1, 3].forEach((f) => { const lv = Math.log10(f * Math.pow(10, e)); if (lv >= x0 && lv <= x1) xt.push(f * Math.pow(10, e)); });
    if (narrow && xt.length > 6) xt = xt.filter((t) => String(t)[0] === '1');
    xt.forEach((t) => {
      const x = X(Math.log10(t));
      grid.append(svgEl('line', { x1: x, x2: x, y1: m.t, y2: H - m.b }));
      const tx = svgEl('text', { x, y: H - m.b + 16, 'text-anchor': 'middle' }); tx.textContent = money(t); axis.append(tx);
    });
    let yt = [1.15, 1.5, 2, 3, 5, 10, 20, 50, 100, 200, 500, 1000, 2000, 5000].filter((y) => Math.log10(y) >= y0 && Math.log10(y) <= y1);
    if (narrow && yt.length > 8) yt = yt.filter((y) => [1.15, 2, 5, 10, 50, 100, 500, 1000, 5000].indexOf(y) >= 0);
    yt.forEach((t) => {
      const y = Y(Math.log10(t));
      grid.append(svgEl('line', { x1: m.l, x2: W - m.r, y1: y, y2: y }));
      const tx = svgEl('text', { x: m.l - 6, y: y + 4, 'text-anchor': 'end' }); tx.textContent = '×' + t; axis.append(tx);
    });
    const guides = svgEl('g');
    [[2, 'Solid: ×2'], [10, '×10 back']].forEach(([g, label]) => {
      const lv = Math.log10(g);
      if (lv <= y0 || lv >= y1) return;
      guides.append(svgEl('line', { x1: m.l, x2: W - m.r, y1: Y(lv), y2: Y(lv) }, 'guide'));
      const t = svgEl('text', { x: W - m.r - 4, y: Y(lv) - 5, 'text-anchor': 'end' }, 'guide-t'); t.textContent = label; guides.append(t);
    });
    const where = toBW() ? 'in the ' + OTHER[S.faction] + ' house (your buyers)' : 'in the ' + FAC[S.faction] + ' house';
    const xtl = svgEl('text', { x: (m.l + W - m.r) / 2, y: H - 8, 'text-anchor': 'middle' }, 'axis-title');
    xtl.textContent = (narrow ? 'Market a day ' : 'Market a day: gold changing hands ') + where;
    const ymid = (m.t + H - m.b) / 2;
    const ytl = svgEl('text', { x: 12, y: ymid, transform: 'rotate(-90 12 ' + ymid + ')', 'text-anchor': 'middle' }, 'axis-title');
    ytl.textContent = 'Money back for each 1g spent';
    svg.append(grid, guides, axis, xtl, ytl);

    const inB = new Set(bask.lines.map((l) => l.o.id));
    const maxP = Math.max.apply(null, pts.map((o) => o.profitDay || 0).concat([1]));
    const R = (o) => 3.2 + (narrow ? 5.5 : 7.5) * Math.sqrt((o.profitDay || 0) / maxP);
    const dots = svgEl('g');
    pts.slice().sort((a, b) => R(a) - R(b)).forEach((o) => {
      const cx = X(Math.log10(o.marketDay)), cy = Y(Math.log10(o.mult)), r = R(o);
      const hit = svgEl('circle', { cx, cy, r: Math.max(11, r + 4), tabindex: 0, 'aria-label': o.name + ', ' + mult(o.mult) + ', ' + money(o.marketDay) + ' a day' }, 'hit');
      const dot = svgEl('circle', { cx, cy, r }, 'dot ' + (o.mult >= 2 ? 'solid' : 'fair') + (inB.has(o.id) ? ' inb' : ''));
      const show = () => { dot.classList.add('on'); showTip(o, hit); };
      const hide = () => { dot.classList.remove('on'); $('tooltip').hidden = true; };
      hit.addEventListener('pointerenter', show); hit.addEventListener('pointerleave', hide);
      hit.addEventListener('focus', show); hit.addEventListener('blur', hide);
      hit.addEventListener('click', (e) => { e.stopPropagation(); show(); });
      dots.append(hit, dot);
    });
    svg.append(dots);
    // direct labels for the biggest earners, skipping any that would collide
    const labels = svgEl('g'), boxes = [];
    const rank = (o) => (o.profitDay || 0) || (o.marketDay || 0) / 1e6;
    pts.slice().sort((a, b) => rank(b) - rank(a)).slice(0, q ? (narrow ? 12 : 30) : (narrow ? 7 : 14)).forEach((o) => {
      const cx = X(Math.log10(o.marketDay)), cy = Y(Math.log10(o.mult)), r = R(o);
      const name = o.name.length > 26 ? o.name.slice(0, 25) + '…' : o.name;
      const w = name.length * 6.2 + 6, h = 15;
      const cands = [[cx + r + 4, cy + 4], [cx - r - 4 - w, cy + 4], [cx - w / 2, cy - r - 6], [cx - w / 2, cy + r + 14]];
      for (const [lx, ly] of cands) {
        const b = { x: lx - 2, y: ly - 11, w, h };
        if (b.x < m.l || b.x + b.w > W - m.r || b.y < m.t || b.y + b.h > H - m.b) continue;
        if (boxes.some((q) => b.x < q.x + q.w && b.x + b.w > q.x && b.y < q.y + q.h && b.y + b.h > q.y)) continue;
        boxes.push(b);
        labels.append(svgEl('rect', { x: b.x, y: b.y, width: b.w, height: b.h, rx: 3 }, 'lab-bg'));
        const t = svgEl('text', { x: lx + 1, y: ly }, 'lab'); t.textContent = name; labels.append(t);
        break;
      }
    });
    svg.append(labels);
  }

  // ---------- the two top-ten tables
  function miniTable(id, list, cols, emptyMsg) {
    const t = $(id); t.textContent = '';
    const thead = el('thead'), hr = el('tr');
    cols.forEach(([h, cls]) => hr.append(el('th', cls, h)));
    thead.append(hr); t.append(thead);
    const tb = el('tbody');
    if (!list.length) { const tr = el('tr'), td = el('td', 'empty', emptyMsg); td.colSpan = cols.length; tr.append(td); tb.append(tr); }
    list.forEach((o, i) => {
      const tr = el('tr'), ti = el('td', 'c-item');
      ti.append(el('span', 'mini-rank', (i + 1) + '. '), itemName(o));
      tr.append(ti);
      cols.slice(1).forEach(([, cls, f]) => { const td = el('td', cls); td.append(f(o)); tr.append(td); });
      tb.append(tr);
    });
    t.append(tb);
  }
  function renderTop10(v) {
    const msg = (v.salesHours || 0) < 1 ? 'Needs sales data: after the next hourly update.' : 'Nothing qualifies yet.';
    miniTable('top-markets', v.items.filter((o) => o.mult >= 2 && o.marketDay > 0).sort((a, b) => b.marketDay - a.marketDay).slice(0, 10),
      [['Item', 'c-item'], ['Market a day', 'num', (o) => coins(o.marketDay)], ['Back per 1g', 'num', (o) => mult(o.mult)]], msg);
    miniTable('top-returns', v.items.filter((o) => o.soldDay >= 4).sort((a, b) => b.mult - a.mult).slice(0, 10),
      [['Item', 'c-item'], ['Back per 1g', 'num', (o) => mult(o.mult)], ['Sold a day', 'num', (o) => num(o.soldDay, 1)]], msg);
  }

  // ---------- shopping list
  function basket(v, budget) {
    const lines = [];
    let left = budget;
    const cands = v.items.filter((o) => o.soldDay >= 1 && o.unitsDay).sort((a, b) => b.mult - a.mult);
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

  function renderBasket(v, b) {
    const box = $('basket'); box.textContent = '';
    if (!v.items.some((o) => o.soldDay >= 1)) { box.append(el('p', 'empty', 'Ready after the next hourly update, so the list only includes items that actually sell.')); return; }
    if (!b.lines.length) { box.append(el('p', 'empty', 'Nothing fits this budget with a safe return right now.')); return; }
    const home = FAC[S.faction];
    const src = toBW() ? home : 'Blackwater', dst = toBW() ? 'Blackwater' : home;
    const tot = el('div', 'basket-total');
    const add = (label, val) => { const s = el('span'); s.append(label + ' ', val); tot.append(s); };
    add('Spend on ' + src + ':', coins(b.spend));
    add('Get back on ' + dst + ':', coins(b.back));
    add('Profit:', join(coins(b.back - b.spend, true), ' (' + mult(b.back / b.spend) + ')'));
    box.append(tot);
    const t = el('table', 'grid');
    const hr = el('tr');
    [['Item', 'c-item'], ['How many', 'num'], ['Pay up to', 'num hide-s'], ['Total cost', 'num'], ['List at', 'num hide-s'], ['Profit', 'num']].forEach(([h, c]) => hr.append(el('th', c, h)));
    const thead = el('thead'); thead.append(hr); t.append(thead);
    const tb = el('tbody');
    b.lines.slice().sort((x, y) => (y.back - y.cost) - (x.back - x.cost)).forEach((l) => {
      const tr = el('tr'), ti = el('td', 'c-item');
      ti.append(itemName(l.o));
      tr.append(ti, numTd(String(l.units)), numTd(coins(l.maxP), 'hide-s'), numTd(coins(l.cost)), numTd(coins(l.o.sell), 'hide-s'), numTd(coins(l.back - l.cost, true)));
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

  // ---------- busiest on Blackwater: only items that resell at a profit in a faction house
  function resellBadges(o) {
    const s = el('span', 'badges');
    [['alliance', o.xA], ['horde', o.xH]].filter((p) => p[1] > 1).sort((a, b) => b[1] - a[1])
      .forEach(([fac, x]) => s.append(el('span', 'badge ' + fac, FAC[fac] + ' ' + mult(x))));
    return s;
  }
  function renderBusy() {
    const t = S.data.neutralTop || { items: [], salesHours: 0 };
    const h = t.salesHours || 0;
    const sub = $('busy-sub'); sub.textContent = '';
    if (h < 1) sub.append('Items people buy on the neutral house that resell at a profit at home. Appears after the next hourly update.');
    else {
      sub.append('Items people buy on the neutral house that can be resold at a profit in the Alliance or Horde house (after its 5% cut), by gold changing hands a day (' + num(h, 0) + (h < 1.5 ? ' hour' : ' hours') + ' of data' + (h < 24 ? ', early estimates' : '') + '). ');
      sub.append('The last three columns are the cheapest listing in each house right now. ');
      if (t.hiddenItems) sub.append('Left out: ' + t.hiddenItems.toLocaleString('en') + ' items (', coins(t.hiddenGold), ' a day) that cost more here than either house pays, mostly players moving goods between their own characters.');
    }
    markHeaders($('busy-card'), S.busySort, S.busyDir);
    const tb = $('busy-body'); tb.textContent = '';
    let list = (t.items || []).slice();
    if (S.busyQuery) { const q = S.busyQuery.toLowerCase(); list = list.filter((o) => o.name.toLowerCase().includes(q)); }
    sortList(list, S.busySort, S.busyDir, (a, b) => b.marketDay - a.marketDay);
    if (!list.length) {
      const tr = el('tr'), td = el('td', 'empty', S.busyQuery ? 'No item matches “' + S.busyQuery + '”.' : 'No profitable Blackwater sales seen yet.');
      td.colSpan = 9; tr.append(td); tb.append(tr); $('busy-more').hidden = true; return;
    }
    const max = Math.max.apply(null, list.map((o) => o.marketDay)) || 1;
    const shown = S.busyAll || S.busyQuery ? list : list.slice(0, BUSY_PAGE);
    shown.forEach((o, i) => {
      const tr = el('tr');
      tr.append(el('td', 'c-rank', String(i + 1)));
      const ti = el('td', 'c-item');
      ti.append(itemName(o));
      const sold = el('span', 'item-sub only-l');
      sold.append(num(o.soldDay, 1) + ' a day at ', coins(o.avg));
      const badgesS = el('span', 'item-sub only-t'); badgesS.append(resellBadges(o));
      const now = el('span', 'item-sub only-s');
      now.append('Now: ');
      if (o.low) now.append('Blackwater ', coins(o.low), ' · ');
      now.append('Alliance ', coins(o.aLow), ' · Horde ', coins(o.hLow));
      ti.append(sold, badgesS, now);
      const rs = el('td', 'hide-t'); rs.append(resellBadges(o));
      const best = (o.xA || 0) >= (o.xH || 0) ? 'a' : 'h';
      tr.append(ti, numTd(num(o.soldDay, 1), 'hide-l'), numTd(coins(o.avg), 'hide-l'), barCell({ marketDay: o.marketDay }, 'marketDay', max), rs,
        numTd(o.low ? coins(o.low) : '', 'hide-s'),
        numTd(coins(o.aLow), 'hide-s' + (best === 'a' ? ' lo' : '')),
        numTd(coins(o.hLow), 'hide-s' + (best === 'h' ? ' lo' : '')));
      tb.append(tr);
    });
    const more = $('busy-more');
    if (!S.busyQuery && list.length > BUSY_PAGE) {
      more.hidden = false;
      more.textContent = S.busyAll ? 'Show the top ' + BUSY_PAGE + ' only' : 'Show all ' + list.length + ' items';
    } else more.hidden = true;
  }

  // ---------- events
  document.querySelectorAll('th[data-sort]').forEach((th) => {
    const label = th.textContent.trim();
    th.textContent = '';
    const b = el('button', 'th-btn');
    b.type = 'button';
    const arrow = el('span', 'th-arrow', '↕');
    arrow.setAttribute('aria-hidden', 'true');
    b.append(el('span', 'th-label', label), arrow);
    th.append(b);
    b.addEventListener('click', (e) => {
      e.stopPropagation();
      const key = th.dataset.sort;
      if (th.closest('#busy-card')) {
        if (S.busySort === key) S.busyDir = S.busyDir === 'asc' ? 'desc' : 'asc'; else { S.busySort = key; S.busyDir = defaultDir(key); }
        remember('busySort', S.busySort + ':' + S.busyDir);
        renderBusy();
      } else {
        const v = view();
        const cur = sorted(v);
        if (cur.key === key) { S.sort = key; S.sortDir = cur.dir === 'asc' ? 'desc' : 'asc'; } else { S.sort = key; S.sortDir = defaultDir(key); }
        remember('sort', S.sort + ':' + S.sortDir);
        renderTable(v);
      }
    });
  });
  document.querySelectorAll('[data-faction]').forEach((b) => b.addEventListener('click', () => {
    S.faction = b.dataset.faction; remember('faction', S.faction); S.showAll = false; S.open.clear(); render();
  }));
  document.querySelectorAll('[data-dir]').forEach((b) => b.addEventListener('click', () => {
    S.dir = b.dataset.dir; remember('dir', S.dir); S.showAll = false; S.open.clear(); render();
  }));
  $('sort').addEventListener('change', (e) => { S.sort = e.target.value; S.sortDir = defaultDir(S.sort); remember('sort', S.sort + ':' + S.sortDir); renderTable(view()); });
  $('budget').addEventListener('change', (e) => { S.budget = Number(e.target.value); remember('budget', S.budget); render(); });
  $('more').addEventListener('click', () => { S.showAll = !S.showAll; renderTable(view()); });
  $('search').addEventListener('input', (e) => { S.query = e.target.value.trim(); renderTable(view()); });
  $('busy-more').addEventListener('click', () => { S.busyAll = !S.busyAll; renderBusy(); });
  $('busy-search').addEventListener('input', (e) => { S.busyQuery = e.target.value.trim(); renderBusy(); });
  $('chart-search').addEventListener('input', (e) => { S.chartQuery = e.target.value.trim(); $('tooltip').hidden = true; renderScatter(view(), basket(view(), S.budget)); });
  document.addEventListener('click', () => { $('tooltip').hidden = true; });
  window.addEventListener('scroll', () => { $('tooltip').hidden = true; }, { passive: true });
  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (S.data) renderScatter(view(), basket(view(), S.budget)); }, 150); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.loadedAt && Date.now() - S.loadedAt > 10 * 60000) load(); });
  setInterval(() => { if (S.data) renderFresh(); }, 60000);

  function applyTheme(light) {
    if (light) document.documentElement.dataset.theme = 'light'; else delete document.documentElement.dataset.theme;
    const b = $('theme');
    b.textContent = '';
    b.append(el('span', null, light ? '☾' : '☀'), el('span', 't-label', light ? ' Night' : ' Parchment'));
    b.firstChild.setAttribute('aria-hidden', 'true');
    b.setAttribute('aria-label', light ? 'Switch to the night (dark) theme' : 'Switch to the parchment (light) theme');
    const meta = document.querySelector('meta[name="theme-color"]');
    if (meta) meta.setAttribute('content', light ? '#e3d1aa' : '#120d08');
  }
  $('theme').addEventListener('click', () => {
    const light = document.documentElement.dataset.theme !== 'light';
    remember('theme', light ? 'light' : 'dark');
    applyTheme(light);
  });

  // ---------- restore
  applyTheme(recall('theme') === 'light');
  const f = recall('faction'); if (f && FAC[f]) S.faction = f;
  const d = recall('dir'); if (d === 'buyNeutralSellHome' || d === 'buyHomeSellNeutral') S.dir = d;
  const so = (recall('sort') || '').split(':');
  if (SORTS[so[0]]) { S.sort = so[0]; S.sortDir = so[1] === 'asc' || so[1] === 'desc' ? so[1] : defaultDir(so[0]); }
  const bs = (recall('busySort') || '').split(':');
  if (BUSY_KEYS[bs[0]]) { S.busySort = bs[0]; S.busyDir = bs[1] === 'asc' || bs[1] === 'desc' ? bs[1] : defaultDir(bs[0]); }
  const bg = Number(recall('budget')); if (bg) { S.budget = bg; $('budget').value = String(bg); }
  load();
})();
