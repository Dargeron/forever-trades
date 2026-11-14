/* Forever Trades - renders data/latest.json. No dependencies. */
(function () {
  'use strict';

  const S = {
    data: null, faction: 'alliance', dir: 'buyNeutralSellHome', sort: 'profitDay', budget: 100000,
    sortDir: 'desc', showAll: false, open: new Set(), query: '',
    busySort: 'marketDay', busyDir: 'desc', busyAll: false, busyQuery: '', chartQuery: '', chartX: 'market',
    tab: 'trade', eng: null, engFor: null, engLoading: false, engError: null,
    engSort: 'profit', engDir: 'desc', engAll: false, engQuery: '', engSkill: 220, engLearn: 'all', engSchool: 'any', engUnknown: false,
  };
  const FAC = { alliance: 'Alliance', horde: 'Horde' };
  const OTHER = { alliance: 'Horde', horde: 'Alliance' };
  const VERSION = 'dev';   // stamped with the commit at deploy time (see update.yml)
  const PAGE = 40, BUSY_PAGE = 25;
  const SORTS = { profitDay: 'Profit a day', mult: 'Back per 1g (×)', marketDay: 'Market a day', soldDay: 'Sold a day', profitEach: 'Profit per item', expected: 'Expected profit (after deposit)', buy: 'Buy price', sell: 'Sell price', name: 'Name' };
  const KEY_LABEL = { profitDay: 'profit a day', mult: 'back per 1g', marketDay: 'market a day (after deposits)', soldDay: 'sold a day', profitEach: 'profit per item', expected: 'expected profit per item, after the deposit', buy: 'buy price', sell: 'sell price', name: 'name' };
  const ALWAYS = { mult: 1, profitEach: 1, expected: 1, buy: 1, sell: 1, name: 1 };
  const BUSY_KEYS = { name: 1, soldDay: 1, avg: 1, marketDay: 1, resellX: 1, low: 1, aLow: 1, hLow: 1 };
  const ENG_KEYS = { name: 1, skill: 1, cost: 1, sell: 1, mult: 1, soldDay: 1, profit: 1, profitDay: 1 };
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
  // Where "sold a day" and "market a day" are counted: the faction house where your buyers are (never Blackwater).
  const buyersAH = () => (toBW() ? OTHER[S.faction] : FAC[S.faction]) + ' AH';
  const PER_HOUSE = { soldDay: 1, marketDay: 1 };
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
    showTab();
    if (S.tab === 'eng') { renderEng(); return; }
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

  function tile(label, value, note, build) {
    const t = el('div', 'tile');
    t.append(el('div', 'label', label));
    const val = el('div', 'value'); val.append(value); t.append(val);
    if (note && typeof note === 'object') {
      const n = el('div', 'note'), b = el('button', 'linkish');
      b.type = 'button'; b.append(itemName(note));
      b.addEventListener('click', (e) => { e.stopPropagation(); openModal(note, (build || details)(note)); });
      n.append(b); t.append(n);
    } else if (note) t.append(el('div', 'note', note));
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
      op.textContent = SORTS[op.value] + (PER_HOUSE[op.value] ? ' (' + buyersAH() + ')' : '') + (ok ? '' : ' (after the first hourly update)');
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
    ['soldDay', 'marketDay'].forEach((k) => {
      const lab = document.querySelector('#rank-card th[data-sort="' + k + '"] .th-label');
      if (lab) lab.textContent = SORTS[k] + ' (' + buyersAH() + ')';
    });
    $('rank-title').textContent = v.items.length ? 'All ' + v.items.length + ' opportunities' : 'Opportunities';
    const order = key === 'name' ? (dir === 'asc' ? 'A to Z' : 'Z to A') : (dir === 'asc' ? 'lowest first' : 'highest first');
    $('rank-sub').textContent = 'Sorted by ' + KEY_LABEL[key] + (PER_HOUSE[key] ? ' in the ' + buyersAH() : '') + ', ' + order + '. Tap a column heading to sort by it (again to flip), or a row for the details. Shading: darker means a bigger return or a bigger market.';
    const tb = $('rank-body'); tb.textContent = '';
    if (!list.length) {
      const tr = el('tr'), td = el('td', 'empty', S.query ? 'No item matches “' + S.query + '”.' : 'No item clears a ×1.15 return right now. Check back after the next update.');
      td.colSpan = 9; tr.append(td); tb.append(tr); $('more').hidden = true; return;
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
      const ex = el('span', 'flag only-s' + (o.expected < 0 ? ' neg' : '')); ex.append('after deposit ', coins(o.expected, true)); sub.append(ex);
      if (toBW()) sub.append(el('span', 'flag', o.undercut ? 'matches Blackwater' : '½ of ' + other + ' ' + money(o.ref)));
      if (o.soldDay === 0) sub.append(el('span', 'flag', 'none sold yet'));
      if (o.trend === 'falling') sub.append(el('span', 'flag warn', (toBW() ? other + ' ' : '') + 'price falling'));
      if (o.trend === 'rising') sub.append(el('span', 'flag up', (toBW() ? other + ' ' : '') + 'price rising'));
      ti.append(sub);
      tr.append(ti, numTd(coins(o.buy), 'hide-s'), numTd(coins(o.sell), 'hide-s'));
      const tdr = numTd(mult(o.mult), 'ret c-ret'); shade(tdr, o.mult, Math.log10(1.15), Math.log10(30)); tr.append(tdr);
      tr.append(numTd(coins(o.expected, true), 'hide-s' + (o.expected < 0 ? ' neg' : '')));
      const tdm = numTd(o.marketDay ? coins(o.marketDay) : '–', 'mkt hide-s'); if (o.marketDay > 0) shade(tdm, o.marketDay, 4, 6.7); tr.append(tdm);
      tr.append(numTd(soldTxt(o), 'hide-m'), barCell(o, barKey, max));
      const dr = el('tr', 'details-row');
      dr.hidden = !S.open.has(o.id);
      const dtd = el('td'); dtd.colSpan = 9; dr.append(dtd);
      if (S.open.has(o.id)) dtd.append(details(o));
      const toggle = () => {
        if (!dtd.firstChild) dtd.append(details(o));
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

  // Why a planning price is below the cheapest listing: the 7-day typical price or what buyers actually paid.
  function priceNote(p, low, paid, med) {
    if (low === null || low === undefined || !(p < low)) return '';
    const why = med && Math.abs(p - med) <= 1 ? '3-day median' : (paid && Math.abs(p - paid) <= 1 ? 'what buyers paid' : '7-day typical');
    return ' (' + why + '; cheapest now ' + money(low) + (low > 1.25 * p ? ': protected from a price spike' : '') + ')';
  }

  // A table row that opens a details row under it, like the main table.
  function expandable(tr, colSpan, build) {
    tr.classList.add('row');
    tr.tabIndex = 0;
    tr.setAttribute('aria-expanded', 'false');
    const dr = el('tr', 'details-row'), td = el('td');
    dr.hidden = true; td.colSpan = colSpan; dr.append(td);
    const toggle = () => {
      if (!td.firstChild) td.append(build());
      dr.hidden = !dr.hidden;
      tr.setAttribute('aria-expanded', String(!dr.hidden));
    };
    tr.addEventListener('click', toggle);
    tr.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); toggle(); } });
    return dr;
  }

  // The same details in a card over the page, for the chart and the summary tiles.
  function openModal(o, body) {
    const t = $('modal-title'), b = $('modal-body');
    t.textContent = ''; t.append(itemName(o));
    b.textContent = ''; b.append(body);
    $('tooltip').hidden = true;
    $('modal').hidden = false;
    $('modal-close').focus();
  }
  function closeModal() { $('modal').hidden = true; }
  function openDialog(title, body) {
    $('modal-title').textContent = title;
    const b = $('modal-body'); b.textContent = ''; b.append(body);
    $('tooltip').hidden = true; $('modal').hidden = false; $('modal-close').focus();
  }

  // ---------- rescan: start the update job on GitHub (Blizzard -> pipeline -> this site)
  // A static page can't start it on its own: GitHub needs a key that may run this repo's workflows. The owner
  // can keep one in this browser only (localStorage, sent only to api.github.com); it is never in the site's code.
  const REPO = 'Dargeron/forever-trades';
  const RUN_PAGE = 'https://github.com/' + REPO + '/actions/workflows/update.yml';
  let watchTimer = null;
  function rescanStatus(msg) { $('rescan-status').textContent = msg; }
  async function rescan() {
    const key = recall('gh-key');
    if (!key) { rescanSetup(); return; }
    const btn = $('rescan'); btn.disabled = true;
    rescanStatus('Starting a rescan…');
    try {
      const r = await fetch('https://api.github.com/repos/' + REPO + '/actions/workflows/update.yml/dispatches', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + key, Accept: 'application/vnd.github+json', 'Content-Type': 'application/json' },
        body: JSON.stringify({ ref: 'main', inputs: { force: 'false' } }),
      });
      if (r.status === 204 || r.status === 200) {
        rescanStatus('Rescan started. If Blizzard has newer prices, this page updates by itself in about 3 minutes.');
        watchForNew();
      } else if (r.status === 401 || r.status === 403 || r.status === 404) {
        rescanStatus('GitHub refused the key (' + r.status + '): it may have expired or lack the Actions permission.');
        rescanSetup();
      } else rescanStatus('GitHub answered ' + r.status + '. Try again in a minute.');
    } catch (e) { rescanStatus('Could not reach GitHub (' + e.message + ').'); }
    btn.disabled = false;
  }
  // Watch for the rebuilt data for up to 6 minutes, then say what happened.
  function watchForNew() {
    clearInterval(watchTimer);
    const was = S.data && S.data.generated, start = Date.now();
    watchTimer = setInterval(async () => {
      try {
        const r = await fetch('data/latest.json?t=' + Date.now(), { cache: 'no-store' });
        const d = await r.json();
        if (d.generated !== was) {
          clearInterval(watchTimer);
          await load();
          rescanStatus('Updated: prices from Blizzard’s snapshot of ' + hhmm(Object.values(d.houses).map((h) => h.snapshot).sort()[0]) + '.');
          return;
        }
      } catch (e) { /* try again next time */ }
      if (Date.now() - start > 6 * 60000) {
        clearInterval(watchTimer);
        rescanStatus('No newer prices from Blizzard yet. It publishes new auction data about every one to two hours; try again later.');
      }
    }, 20000);
  }
  function rescanSetup() {
    const box = el('div', 'details rescan-setup');
    box.append(el('p', null, 'A rescan asks Blizzard for its newest auction snapshot and rebuilds this site, in about 2–3 minutes. Blizzard publishes new prices about every one to two hours, so a rescan helps once a newer snapshot exists; the site also checks by itself every hour.'));
    box.append(el('h4', 'history-title', 'Quick way: on GitHub'));
    const p1 = el('p'), a = el('a', 'copy', 'Open GitHub’s “Run workflow” page');
    a.href = RUN_PAGE; a.target = '_blank'; a.rel = 'noopener';
    p1.append(a, el('br'), el('span', 'muted', 'Signed in as the site’s owner, tap “Run workflow”, then the green “Run workflow” button.'));
    box.append(p1);
    box.append(el('h4', 'history-title', 'One tap from this device'));
    const ol = el('ol');
    const li1 = el('li'), a2 = el('a', null, 'GitHub’s new fine-grained token page');
    a2.href = 'https://github.com/settings/personal-access-tokens/new'; a2.target = '_blank'; a2.rel = 'noopener';
    li1.append('Open ', a2, ' (signed in as the site’s owner). Give it any name and an expiry date.');
    ol.append(li1,
      el('li', null, 'Repository access: “Only select repositories” → forever-trades.'),
      el('li', null, 'Permissions → Repository permissions → Actions: “Read and write”. Nothing else.'),
      el('li', null, 'Generate the token, copy it and paste it here:'));
    box.append(ol);
    const row = el('div', 'key-row'), inp = el('input'), save = el('button', 'copy', 'Save and rescan');
    inp.type = 'password'; inp.placeholder = 'github_pat_…'; inp.autocomplete = 'off'; inp.setAttribute('aria-label', 'GitHub token');
    save.type = 'button';
    save.addEventListener('click', () => {
      const k = inp.value.trim();
      if (!/^(github_pat_|ghp_)[A-Za-z0-9_]{20,}$/.test(k)) { inp.focus(); rescanStatus('That doesn’t look like a GitHub token.'); return; }
      remember('gh-key', k); closeModal(); rescan();
    });
    row.append(inp, save); box.append(row);
    box.append(el('p', 'muted', 'The key stays in this browser on this device and is sent only to GitHub. It can only start this site’s update job. Don’t paste it anywhere else.'));
    if (recall('gh-key')) {
      const f = el('button', 'copy', 'Forget the key on this device'); f.type = 'button';
      f.addEventListener('click', () => { try { localStorage.removeItem('ft-gh-key'); } catch (e) { /* ignore */ } closeModal(); rescanStatus('Key forgotten.'); });
      box.append(f);
    }
    openDialog('Rescan the auction houses', box);
  }

  function depTxt(o) { return o.depKnown === false ? join(coins(o.dep), ' (at least; vendor price unknown)') : coins(o.dep); }
  function mktTxt(o) {
    if (!o.marketDay && o.marketDay !== 0) return '–';
    return o.marketGross ? join(coins(o.marketDay), ' ', el('span', 'muted', '(' + money(o.marketGross) + ' before a ' + money(o.mktDep) + ' deposit each)')) : coins(o.marketDay);
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
      [other + ' price', join(coins(o.ref), priceNote(o.ref, o.refLow, o.refPaid, o.refMed))],
      ['Paid on average in the ' + other + ' house', o.refPaid ? coins(o.refPaid) : 'no sales seen yet'],
      [(sh === 50 ? 'Half' : sh + '%') + ' of that', coins(o.half)],
      ['Cheapest on Blackwater', o.dstLow === null ? 'none listed' : join(coins(o.dstLow), o.undercut ? ' (competition: matched)' : ' (ignored: too high)')],
      ['Sell at (Blackwater)', join(coins(o.sell), o.undercut ? ', matching Blackwater' : ', ' + (sh === 50 ? 'half' : sh + '% of') + ' the ' + other + ' price')],
      ['You get back (after 15% cut)', coins(o.back)],
      ['Profit per item', coins(o.profitEach, true)],
      ['Deposit on Blackwater (24 h; lost if it doesn’t sell)', depTxt(o)],
      ['Expected profit, deposit lost', coins(o.expected, true)],
      ['Return', mult(o.mult) + ' · ' + o.tag],
      ['Sold a day in the ' + other + ' house', soldTxt(o)],
      ['Your share a day', shareTxt(o)],
      ['Spend a day', spend],
      ['Profit a day', o.profitDay ? coins(o.profitDay, true) : '–'],
      ['Listed in the ' + other + ' house', num(o.refQty, 0)],
      ['Gold a day in the ' + other + ' house, after deposits', mktTxt(o)],
    ] : [
      ['Buy at (Blackwater)', buyNode],
      ['Listed on Blackwater', num(o.srcQty, 0)],
      ['Sell at (' + home + ')', join(coins(o.sell), priceNote(o.sell, o.dstLow, o.dstPaid, o.dstMed))],
      ['Paid on average in the ' + home + ' house', o.dstPaid ? coins(o.dstPaid) : 'no sales seen yet'],
      ['You get back (after 5% cut)', coins(o.back)],
      ['Profit per item', coins(o.profitEach, true)],
      ['Deposit in the ' + home + ' house (24 h; lost if it doesn’t sell)', depTxt(o)],
      ['Expected profit, deposit lost', coins(o.expected, true)],
      ['Return', mult(o.mult) + ' · ' + o.tag],
      ['Sold a day in the ' + home + ' house', soldTxt(o)],
      ['Your share a day', shareTxt(o)],
      ['Spend a day', spend],
      ['Profit a day', o.profitDay ? coins(o.profitDay, true) : '–'],
      ['Listed in the ' + home + ' house', num(o.dstQty, 0)],
      ['7-day typical in the ' + home + ' house', o.dstTyp ? coins(o.dstTyp) : 'building'],
      ['Gold a day in the ' + home + ' house, after deposits', mktTxt(o)],
    ];
    rows.forEach(([k, val]) => { const kv = el('div', 'kv'), dd = el('dd'); dd.append(val); kv.append(el('dt', null, k), dd); dl.append(kv); });
    box.append(dl);
    const n = o.unitsDay ? Math.max(1, Math.floor(o.unitsDay)) : 1;
    const how = el('p', 'how');
    how.append('Today: buy up to ' + n + (toBW() ? ' in the ' + home + ' house' : ' on Blackwater') + ' at ', coins(o.buy),
      ' or less, and list ' + (toBW() ? 'on Blackwater' : 'in the ' + home + ' house') + ' at about ', coins(o.sell), '.');
    box.append(how, historySection(o.id));
    return box;
  }

  // ---------- price history of one item: graph and summary, loaded when the item is opened
  const HOUSES = ['alliance', 'horde', 'neutral'];
  const HOUSE_NAME = { alliance: 'Alliance', horde: 'Horde', neutral: 'Blackwater' };
  const HOUSE_SHORT = { alliance: 'Alli.', horde: 'Horde', neutral: 'BW' };
  function historySection(id) {
    const box = el('div', 'history');
    box.append(el('h4', 'history-title', 'Price history'));
    const body = el('div', 'history-body', 'Loading the price history…');
    box.append(body);
    fetch('data/series/' + id + '.json?g=' + encodeURIComponent(S.data.generated), { cache: 'no-store' })
      .then((r) => { if (!r.ok) throw new Error('HTTP ' + r.status); return r.json(); })
      .then((f) => { body.textContent = ''; body.append(historyChart(f), historyLegend(f), historyTable(f)); })
      .catch(() => { body.textContent = 'No price history for this item yet.'; });
    return box;
  }
  function timeLabel(tmin, withDay) {
    const d = new Date(tmin * 60000);
    const hm = d.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
    return withDay ? d.toLocaleDateString([], { weekday: 'short' }) + ' ' + hm : hm;
  }
  function historyChart(f) {
    const lines = HOUSES.map((h) => ({ h, pts: ((f.h || {})[h] || []).filter((p) => p[1] > 0) })).filter((l) => l.pts.length);
    const n = lines.reduce((a, l) => a + l.pts.length, 0);
    if (n < 2) return el('p', 'empty', 'The graph builds up with every hourly snapshot from Blizzard; check back in a few hours.');
    const W = 640, H = 210, m = { l: 58, r: 12, t: 10, b: 26 };
    const ts = [].concat.apply([], lines.map((l) => l.pts.map((p) => p[0])));
    let t0 = Math.min.apply(null, ts), t1 = Math.max.apply(null, ts);
    if (t1 - t0 < 120) { t0 -= 60; t1 += 60; }
    const meds = lines.map((l) => ((f.s || {})[l.h] || {}).med).filter((x) => x > 0);
    const vs = [].concat.apply([], lines.map((l) => l.pts.map((p) => p[1]))).concat(meds).map((x) => Math.log10(x));
    let v0 = Math.min.apply(null, vs), v1 = Math.max.apply(null, vs);
    if (v1 - v0 < 0.4) { const mid = (v0 + v1) / 2; v0 = mid - 0.2; v1 = mid + 0.2; }
    const pad = (v1 - v0) * 0.06; v0 -= pad; v1 += pad;
    const X = (t) => m.l + (t - t0) / (t1 - t0) * (W - m.l - m.r);
    const Y = (c) => H - m.b - (Math.log10(c) - v0) / (v1 - v0) * (H - m.t - m.b);
    const svg = svgEl('svg', { viewBox: '0 0 ' + W + ' ' + H, role: 'img', 'aria-label': 'Cheapest price over time in each house' }, 'hchart');
    const grid = svgEl('g', {}, 'hgrid'), axis = svgEl('g', {}, 'haxis');
    let ticks = [];
    for (let e = Math.floor(v0); e <= Math.ceil(v1); e++) [1, 2, 5].forEach((k) => { const c = k * Math.pow(10, e), lv = Math.log10(c); if (lv >= v0 && lv <= v1) ticks.push(c); });
    if (ticks.length > 6) ticks = ticks.filter((c) => String(c)[0] === '1');
    ticks.forEach((c) => {
      grid.append(svgEl('line', { x1: m.l, x2: W - m.r, y1: Y(c), y2: Y(c) }));
      const tx = svgEl('text', { x: m.l - 6, y: Y(c) + 4, 'text-anchor': 'end' }); tx.textContent = money(c); axis.append(tx);
    });
    const span = t1 - t0, withDay = span > 20 * 60;
    for (let k = 0; k <= 4; k++) {
      const t = t0 + span * k / 4;
      const tx = svgEl('text', { x: X(t), y: H - 8, 'text-anchor': k === 0 ? 'start' : (k === 4 ? 'end' : 'middle') }); tx.textContent = timeLabel(t, withDay); axis.append(tx);
    }
    svg.append(grid, axis);
    lines.forEach((l) => {
      const med = ((f.s || {})[l.h] || {}).med;
      if (med > 0) svg.append(svgEl('line', { x1: m.l, x2: W - m.r, y1: Y(med), y2: Y(med) }, 'hmed ' + l.h));
      if (l.pts.length > 1) svg.append(svgEl('polyline', { points: l.pts.map((p) => X(p[0]).toFixed(1) + ',' + Y(p[1]).toFixed(1)).join(' ') }, 'hline ' + l.h));
      l.pts.forEach((p) => {
        const c = svgEl('circle', { cx: X(p[0]), cy: Y(p[1]), r: 3 }, 'hdot ' + l.h);
        const tt = svgEl('title'); tt.textContent = HOUSE_NAME[l.h] + ', ' + timeLabel(p[0], true) + ': cheapest ' + money(p[1]) + ', market ' + money(p[2]);
        c.append(tt); svg.append(c);
      });
    });
    return svg;
  }
  function historyLegend(f) {
    const p = el('p', 'hlegend');
    HOUSES.forEach((h) => { if (((f.h || {})[h] || []).length) { const s = el('span'); s.append(el('i', 'sw ' + h), HOUSE_NAME[h] + ': cheapest listing'); p.append(s); } });
    const s = el('span'); s.append(el('i', 'sw dash'), 'Dashed: 3-day median'); p.append(s);
    return p;
  }
  function historyTable(f) {
    // One row per measure, one column per house: four narrow columns fit even a small phone.
    const since = S.data.trackingSince ? new Date(S.data.trackingSince + 'T12:00:00Z').toLocaleDateString([], { day: 'numeric', month: 'short' }) : 'start';
    const st = (h) => (f.s || {})[h] || {};
    const hs = HOUSES.filter((h) => { const s = st(h); return s.now || s.med || s.min7 || s.minAll || s.paid; });
    const t = el('table', 'grid mini history-table');
    const hr = el('tr'); hr.append(el('th', null, ''));
    hs.forEach((h) => { const th = el('th', 'num'); th.title = HOUSE_NAME[h]; th.append(el('i', 'sw ' + h), ' ', el('span', 'hn-full', HOUSE_NAME[h]), el('span', 'hn-short', HOUSE_SHORT[h])); hr.append(th); });
    const thead = el('thead'); thead.append(hr); t.append(thead);
    const tb = el('tbody');
    [['Cheapest now', (s) => (s.now ? coins(s.now) : 'none')],
     ['Median, 3 days', (s) => (s.med ? coins(s.med) : 'building')],
     ['Cheapest, 7 days', (s) => (s.min7 ? coins(s.min7) : '–')],
     ['Cheapest since ' + since, (s) => (s.minAll ? coins(s.minAll[0]) : '–')],
     ['Paid on average', (s) => (s.paid ? coins(s.paid) : '–')],
     ['Listed now', (s) => num(s.qty || 0, 0)]].forEach(([label, f2]) => {
      const tr = el('tr'); tr.append(el('td', 'hlabel', label));
      hs.forEach((h) => tr.append(numTd(f2(st(h)))));
      tb.append(tr);
    });
    t.append(tb);
    return t;
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
    rows.push(['Sell', coins(o.sell)], ['Expected profit (after deposit)', coins(o.expected, true)], ['Profit a day', o.profitDay ? coins(o.profitDay, true) : '–'], ['Sold a day (' + buyersAH() + ')', soldTxt(o)], ['Market a day (' + buyersAH() + ')', coins(o.marketDay)]);
    rows.forEach(([a, b]) => { const r = el('div', 'tr'), vb = el('span'); vb.append(b); r.append(el('span', null, a), vb); tip.append(r); });
    tip.append(el('div', 'tfoot', 'Click the dot for all the details'));
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
    // Across: market a day (gold changing hands where your buyers are) or the sale price of one item.
    const byPrice = S.chartX === 'price';
    const xv = (o) => (byPrice ? o.sell : o.marketDay);
    const sellWhere = toBW() ? 'on Blackwater' : 'in the ' + FAC[S.faction] + ' house';
    $('scatter-title').textContent = byPrice ? 'Return against sale price' : 'Return against market size';
    $('scatter-sub').textContent = 'Every item we have seen selling. Up means more money back for each gold you spend; right means ' +
      (byPrice ? 'a dearer item (its sale price ' + sellWhere + ')' : 'more gold changes hands each day') + '. Hover or tap a dot to see the item.';
    const all = v.items.filter((o) => o.marketDay > 0 && o.mult > 0 && xv(o) > 0);
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
    // Scale and dot sizes always come from every item, so the search box only hides dots: nothing moves.
    const xs = all.map((o) => Math.log10(xv(o))), ys = all.map((o) => Math.log10(o.mult));
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
    xtl.textContent = byPrice ? 'Sale price of one item ' + sellWhere : (narrow ? 'Market a day ' : 'Market a day: gold changing hands ') + where;
    const ymid = (m.t + H - m.b) / 2;
    const ytl = svgEl('text', { x: 12, y: ymid, transform: 'rotate(-90 12 ' + ymid + ')', 'text-anchor': 'middle' }, 'axis-title');
    ytl.textContent = 'Money back for each 1g spent';
    svg.append(grid, guides, axis, xtl, ytl);

    const inB = new Set(bask.lines.map((l) => l.o.id));
    // Dot size: the sale price of one item (owner's request), from all items so a search never resizes a dot.
    // Prices run from a few copper to hundreds of gold, so the size steps up evenly with each tenfold rise
    // in price: proportional to the price itself, nearly every dot would be a pinpoint next to the dearest one.
    const lp = all.map((o) => Math.log10(Math.max(1, o.sell)));
    const p0 = Math.min.apply(null, lp), p1 = Math.max.apply(null, lp);
    const rMin = 2.8, rMax = narrow ? 9 : 12;
    const R = (o) => rMin + (rMax - rMin) * (p1 > p0 ? (Math.log10(Math.max(1, o.sell)) - p0) / (p1 - p0) : 0.5);
    renderSizeKey(p0, p1, R);
    const dots = svgEl('g');
    pts.slice().sort((a, b) => R(b) - R(a)).forEach((o) => {      // biggest first, so small dots stay visible on top
      const cx = X(Math.log10(xv(o))), cy = Y(Math.log10(o.mult)), r = R(o);
      const hit = svgEl('circle', { cx, cy, r: Math.max(11, r + 4), tabindex: 0, 'aria-label': o.name + ', ' + mult(o.mult) + ', ' + (byPrice ? 'sells for ' + money(o.sell) : money(o.marketDay) + ' a day') }, 'hit');
      const dot = svgEl('circle', { cx, cy, r }, 'dot ' + (o.mult >= 2 ? 'solid' : 'fair') + (inB.has(o.id) ? ' inb' : ''));
      const show = () => { dot.classList.add('on'); showTip(o, hit); };
      const hide = () => { dot.classList.remove('on'); $('tooltip').hidden = true; };
      hit.addEventListener('pointerenter', show); hit.addEventListener('pointerleave', hide);
      hit.addEventListener('focus', show); hit.addEventListener('blur', hide);
      hit.addEventListener('click', (e) => { e.stopPropagation(); hide(); openModal(o, details(o)); });
      hit.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openModal(o, details(o)); } });
      dots.append(hit, dot);
    });
    svg.append(dots);
    // direct labels for the biggest earners, skipping any that would collide
    const labels = svgEl('g'), boxes = [];
    const rank = (o) => (o.profitDay || 0) || (o.marketDay || 0) / 1e6;
    pts.slice().sort((a, b) => rank(b) - rank(a)).slice(0, q ? (narrow ? 12 : 30) : (narrow ? 7 : 14)).forEach((o) => {
      const cx = X(Math.log10(xv(o))), cy = Y(Math.log10(o.mult)), r = R(o);
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

  // The chart's size key: a few sample dots (whole powers of ten within the prices on the chart) and their price.
  function renderSizeKey(p0, p1, R) {
    const key = $('size-key'); key.textContent = '';
    key.append('Dot size: what one sells for');
    let refs = [];
    for (let e = Math.ceil(p0); e <= Math.floor(p1); e++) refs.push(Math.pow(10, e));
    if (refs.length > 4) refs = refs.filter((_, k) => (refs.length - 1 - k) % 2 === 0);
    if (refs.length < 2) refs = [Math.pow(10, p0), Math.pow(10, p1)].filter((x, k, a) => k === 0 || x !== a[0]);
    refs.forEach((c) => {
      const r = R({ sell: c }), s = Math.ceil(r * 2 + 2);
      const sv = svgEl('svg', { width: s, height: s, viewBox: '0 0 ' + s + ' ' + s, 'aria-hidden': 'true' }, 'size-dot');
      sv.append(svgEl('circle', { cx: s / 2, cy: s / 2, r }));
      const item = el('span', 'size-ref'); item.append(sv, money(c));
      key.append(item);
    });
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
      tb.append(tr, expandable(tr, cols.length, () => details(o)));
    });
    t.append(tb);
  }
  function renderTop10(v) {
    const msg = (v.salesHours || 0) < 1 ? 'Needs sales data: after the next hourly update.' : 'Nothing qualifies yet.';
    miniTable('top-markets', v.items.filter((o) => o.mult >= 2 && o.marketDay > 0).sort((a, b) => b.marketDay - a.marketDay).slice(0, 10),
      [['Item', 'c-item'], ['Market a day (' + buyersAH() + ')', 'num', (o) => coins(o.marketDay)], ['Sold a day (' + buyersAH() + ')', 'num', (o) => num(o.soldDay, 1)], ['Back per 1g', 'num', (o) => mult(o.mult)]], msg);
    miniTable('top-returns', v.items.filter((o) => o.soldDay >= 4).sort((a, b) => b.mult - a.mult).slice(0, 10),
      [['Item', 'c-item'], ['Back per 1g', 'num', (o) => mult(o.mult)], ['Sold a day (' + buyersAH() + ')', 'num', (o) => num(o.soldDay, 1)]], msg);
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
      tb.append(tr, expandable(tr, 6, () => details(l.o)));
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
  // A faction price for the Blackwater table: the cheapest listing now; if none is listed, the recent price
  // the resell ratio used (median or what buyers paid), marked as such so the badge and the numbers agree.
  function facNow(low, ref) {
    if (low) return coins(low);
    if (ref) { const s = el('span', 'muted'); s.append('none now · ', coins(ref), ' recent'); return s; }
    return '–';
  }

  function busyDetails(o) {
    const box = el('div', 'details'), dl = el('dl');
    const bestFac = (o.xA || 0) >= (o.xH || 0) ? 'alliance' : 'horde';
    const bestX = bestFac === 'alliance' ? o.xA : o.xH, bestRef = bestFac === 'alliance' ? o.aRef : o.hRef;
    const rows = [
      ['Sold a day on Blackwater', num(o.soldDay, 1)],
      ['Average price paid on Blackwater', coins(o.avg)],
      ['Gold a day on Blackwater', coins(o.marketDay)],
      ['Cheapest on Blackwater now', o.low ? coins(o.low) : 'none listed'],
      ['Listed on Blackwater', num(o.qty, 0)],
      ['Cheapest in the Alliance house now', facNow(o.aLow, o.aRef)],
      ['Cheapest in the Horde house now', facNow(o.hLow, o.hRef)],
      ['Resell in the Alliance house', o.xA ? join(mult(o.xA), ' at ', coins(o.aRef)) : '–'],
      ['Resell in the Horde house', o.xH ? join(mult(o.xH), ' at ', coins(o.hRef)) : '–'],
      ['Ratios compared with', o.basisNow ? join('today’s cheapest Blackwater listing, ', coins(o.low)) : join('what buyers paid (nothing listed now), ', coins(o.avg))],
    ];
    rows.forEach(([k, val]) => { const kv = el('div', 'kv'), dd = el('dd'); dd.append(val); kv.append(el('dt', null, k), dd); dl.append(kv); });
    box.append(dl);
    const how = el('p', 'how');
    how.append(o.basisNow ? 'Bought here at today’s cheapest listing, ' : 'Nothing is listed here right now; bought at what buyers paid, ', coins(o.basisNow ? o.low : o.avg),
      ', it resells in the ' + FAC[bestFac] + ' house at about ', coins(bestRef),
      ': ' + mult(bestX) + ' after that house’s 5% cut. Resell prices are the cautious ones: the cheapest listing, or the 3-day median or what buyers actually paid if lower.');
    box.append(how, historySection(o.id));
    return box;
  }

  function renderBusy() {
    const t = S.data.neutralTop || { items: [], salesHours: 0 };
    const h = t.salesHours || 0;
    const sub = $('busy-sub'); sub.textContent = '';
    if (h < 1) sub.append('Items people buy on the neutral house that resell at a profit at home. Appears after the next hourly update.');
    else {
      sub.append('Items people buy on the neutral house that you could buy there now and resell at a profit in the Alliance or Horde house (after its 5% cut), by gold changing hands a day (' + num(h, 0) + (h < 1.5 ? ' hour' : ' hours') + ' of data' + (h < 24 ? ', early estimates' : '') + '). The ×-ratios compare with today’s cheapest Blackwater listing, or with what buyers paid when none is listed. ');
      sub.append('The last three columns are the cheapest listing in each house right now. ');
      if (t.hiddenItems) sub.append('Left out: ' + t.hiddenItems.toLocaleString('en') + ' items (', coins(t.hiddenGold), ' a day) that cost more here right now than either house pays; many are players moving goods between their own characters.');
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
      now.append('Alliance ', facNow(o.aLow, o.aRef), ' · Horde ', facNow(o.hLow, o.hRef));
      ti.append(sold, badgesS, now);
      const rs = el('td', 'hide-t'); rs.append(resellBadges(o));
      const best = (o.xA || 0) >= (o.xH || 0) ? 'a' : 'h';
      tr.append(ti, numTd(num(o.soldDay, 1), 'hide-l'), numTd(coins(o.avg), 'hide-l'), barCell({ marketDay: o.marketDay }, 'marketDay', max), rs,
        numTd(o.low ? coins(o.low) : '', 'hide-s'),
        numTd(facNow(o.aLow, o.aRef), 'hide-s' + (best === 'a' ? ' lo' : '')),
        numTd(facNow(o.hLow, o.hRef), 'hide-s' + (best === 'h' ? ' lo' : '')));
      tb.append(tr, expandable(tr, 9, () => busyDetails(o)));
    });
    const more = $('busy-more');
    if (!S.busyQuery && list.length > BUSY_PAGE) {
      more.hidden = false;
      more.textContent = S.busyAll ? 'Show the top ' + BUSY_PAGE + ' only' : 'Show all ' + list.length + ' items';
    } else more.hidden = true;
  }

  // ---------- tabs: auction trades | engineering (#engineering)
  function showTab() {
    const eng = S.tab === 'eng';
    $('trade-view').hidden = eng; $('eng-view').hidden = !eng;
    $('dir-seg').hidden = eng;
    $('tab-trade').setAttribute('aria-selected', String(!eng));
    $('tab-eng').setAttribute('aria-selected', String(eng));
  }
  function setTab(tab, push) {
    if (tab === S.tab) return;
    S.tab = tab; remember('tab', tab);
    if (push) history.replaceState(null, '', location.pathname + location.search + (tab === 'eng' ? '#engineering' : ''));
    $('tooltip').hidden = true;
    render();
  }

  // ---------- engineering: what to craft and sell in your faction's house (data/engineering.json)
  async function loadEng() {
    if (S.engLoading || !S.data) return;
    S.engLoading = true; S.engError = null;
    const want = S.data.generated;
    try {
      const r = await fetch('data/engineering.json?g=' + encodeURIComponent(want), { cache: 'no-store' });
      if (!r.ok) throw new Error('HTTP ' + r.status);
      S.eng = await r.json(); S.engFor = want;
    } catch (e) { S.engError = e.message; }
    S.engLoading = false;
    if (S.tab === 'eng') renderEng();
  }
  function fineCoins(c) {
    if (bad(c) || c >= 20 || Math.abs(c - Math.round(c)) < 0.05) return coins(c);
    const span = el('span', 'money');
    span.append(String(Math.round(c * 10) / 10), el('span', 'uc', 'c'));
    return span;
  }
  function engName(i) { const n = (S.eng.names || {})[i] || ['Item #' + i, 1]; return { id: i, name: n[0], q: n[1] }; }
  function qtyTxt(q) { return Math.abs(q - Math.round(q)) < 1e-6 ? String(Math.round(q)) : num(q, 2); }
  function learnTxt(o) { return o.school ? (o.school === 'gnomish' ? 'Gnomish' : 'Goblin') : ({ schematic: 'Schematic', unknown: 'Forever recipe' }[o.learn] || 'Trainer'); }
  function skillTxt(o) { return o.skill === null || o.skill === undefined ? '?' : String(o.skill); }
  function engShare(o) { return o.soldDay ? 0.25 * o.soldDay : null; }

  function engList() {
    const f = S.eng.factions[S.faction] || { items: [] };
    let list = f.items.filter((o) => (o.skill === null || o.skill === undefined ? S.engUnknown : o.skill <= S.engSkill)
      && (S.engLearn === 'all' || o.learn === 'trainer')
      && (S.engSchool === 'any' || (S.engSchool === 'none' ? !o.school : !o.school || o.school === S.engSchool)));
    if (S.engQuery) { const q = S.engQuery.toLowerCase(); list = list.filter((o) => o.name.toLowerCase().includes(q)); }
    const val = (o) => (o.profit === null || o.profit === undefined ? -1e15 : o.profit);
    sortList(list, S.engSort, S.engDir, (a, b) => val(b) - val(a));
    return list;
  }

  function renderEng() {
    const home = FAC[S.faction];
    $('eng-explain').textContent = 'What to make with Engineering and sell in the ' + home + ' auction house. Each material is priced the cheapest way you can get it: bought in the ' + home + ' house, bought from a vendor, or made by you (smelting ore into bars, making the parts), and compared with what the finished item sells for there after the 5% cut.';
    const sold = document.querySelector('#eng-card th[data-sort="soldDay"] .th-label');
    if (sold) sold.textContent = 'Sold a day (' + home + ' AH)';
    markHeaders($('eng-card'), S.engSort, S.engDir);
    const tb = $('eng-body');
    if (!S.eng || S.engFor !== S.data.generated) {
      tb.textContent = '';
      const tr = el('tr'), td = el('td', 'empty', S.engError ? 'Could not load the recipes (' + S.engError + '). Try again in a minute.' : 'Loading the recipes…');
      td.colSpan = 9; tr.append(td); tb.append(tr);
      $('eng-tiles').textContent = ''; $('eng-more').hidden = true;
      if (!S.engError) loadEng();
      return;
    }
    const f = S.eng.factions[S.faction] || { items: [], salesHours: 0 };
    const h = f.salesHours || 0, bn = $('eng-banner');
    bn.textContent = '';
    bn.hidden = h >= 24;
    if (h < 24) bn.append(el('b', null, 'Early estimates. '), 'Sales figures are based on ' + num(h, 0) + (h < 1.5 ? ' hour' : ' hours') + ' of snapshots so far and will settle over a day or two. Prices and material costs are today’s.');
    const list = engList();
    renderEngTiles(list);
    const n = list.length, total = f.items.length;
    const unknown = f.items.filter((o) => o.skill === null || o.skill === undefined).length;
    $('eng-unknown-label').textContent = 'Forever recipes with unknown skill (' + unknown + ')';
    $('eng-unknown').closest('label').hidden = !unknown;
    $('eng-title').textContent = n ? n + ' recipes up to skill ' + S.engSkill : 'Engineering recipes';
    const order = S.engSort === 'name' ? (S.engDir === 'asc' ? 'A to Z' : 'Z to A') : (S.engDir === 'asc' ? 'lowest first' : 'highest first');
    const lab = { name: 'name', skill: 'skill', cost: 'materials', sell: 'selling price', mult: 'back per 1g', soldDay: 'sold a day', profit: 'profit per craft', profitDay: 'profit a day' }[S.engSort];
    $('eng-sub').textContent = 'Sorted by ' + lab + ', ' + order + '. Tap a column heading to sort by it, or a recipe for its materials, step by step. Showing ' + n + ' of the ' + total + ' Engineering recipes that make something you can sell.';
    tb.textContent = '';
    if (!list.length) {
      const tr = el('tr'), td = el('td', 'empty', S.engQuery ? 'No recipe matches “' + S.engQuery + '”.' : 'No recipe matches these filters.');
      td.colSpan = 9; tr.append(td); tb.append(tr); $('eng-more').hidden = true; return;
    }
    const max = Math.max.apply(null, list.map((o) => o.profit || 0)) || 1;
    const shown = S.engAll || S.engQuery ? list : list.slice(0, PAGE);
    shown.forEach((o, i) => {
      const tr = el('tr', o.profit === null ? 'nodata' : (o.profit <= 0 ? 'loss' : ''));
      tr.append(el('td', 'c-rank', String(i + 1)));
      const ti = el('td', 'c-item');
      ti.append(itemName(o));
      const sub = el('span', 'item-sub');
      sub.append(el('span', 'flag', 'Skill ' + skillTxt(o)), el('span', 'flag', learnTxt(o)));
      if (o.n !== 1) sub.append(el('span', 'flag', 'makes ' + num(o.n, 1)));
      if (o.missing && o.missing.length) sub.append(el('span', 'flag warn', 'no price for ' + o.missing.join(', ')));
      if (!o.sell) sub.append(el('span', 'flag', 'not seen in the ' + home + ' house'));
      ti.append(sub);
      const ms = el('span', 'item-sub only-s');
      ms.append('Materials ', coins(o.cost), ' → sells ', o.sell ? fineCoins(o.sell) : '–', o.n !== 1 ? ' each' : '');
      const sd = el('span', 'item-sub only-m');
      sd.append('Sold a day (' + home + ' AH): ' + soldTxt(o));
      ti.append(ms, sd);
      tr.append(ti, numTd(skillTxt(o), 'hide-l'), numTd(coins(o.cost), 'hide-s'), numTd(o.sell ? fineCoins(o.sell) : '–', 'hide-s'));
      const tdr = numTd(mult(o.mult), 'ret c-ret'); if (o.mult) shade(tdr, o.mult, Math.log10(1.15), Math.log10(30)); tr.append(tdr);
      tr.append(numTd(soldTxt(o), 'hide-m'));
      const bar = el('td', 'c-bar'), val = el('span', 'val');
      if (o.profit === null) val.append(el('span', 'muted', '–')); else val.append(coins(o.profit, true));
      const track = el('span', 'track'), fill = el('span', 'fill');
      fill.style.width = (o.profit > 0 ? Math.max(1.5, Math.min(100, 100 * o.profit / max)) : 0) + '%';
      track.append(fill); bar.append(val, track); tr.append(bar);
      tr.append(numTd(o.profitDay ? coins(o.profitDay, true) : '–', 'hide-t'));
      tb.append(tr, expandable(tr, 9, () => engDetails(o)));
    });
    const more = $('eng-more');
    if (!S.engQuery && list.length > PAGE) {
      more.hidden = false;
      more.textContent = S.engAll ? 'Show the top ' + PAGE + ' only' : 'Show all ' + list.length + ' recipes';
    } else more.hidden = true;
  }

  function renderEngTiles(list) {
    const box = $('eng-tiles'); box.textContent = '';
    const good = list.filter((o) => o.profit > 0);
    if (!good.length) { box.append(tile('Recipes that make a profit', '0', 'None at these settings right now')); return; }
    const best = good.reduce((a, o) => (o.profit > a.profit ? o : a));
    const day = good.filter((o) => o.profitDay > 0);
    box.append(tile('Biggest profit per craft', coins(best.profit, true), best, engDetails));
    if (day.length) {
      const bd = day.reduce((a, o) => (o.profitDay > a.profitDay ? o : a));
      box.append(tile('Best profit a day', coins(bd.profitDay, true), bd, engDetails));
    }
    box.append(tile('Recipes that make a profit', good.length + ' of ' + list.length, 'Up to skill ' + S.engSkill + ', at today’s prices'));
  }

  // One line per material: how much, the cheapest way to get it, and what the other ways cost.
  function matList(nodes) {
    const ul = el('ul', 'mats');
    nodes.forEach((p) => {
      const li = el('li'), line = el('div', 'mat-line');
      const info = engName(p.i), b = el('button', 'linkish');
      b.type = 'button'; b.append(itemName(info));
      b.addEventListener('click', (e) => { e.stopPropagation(); openModal(info, matPanel(p, info)); });
      line.append(el('span', 'mat-q', qtyTxt(p.qty) + ' × '), b, ' ');
      const how = el('span', 'mat-how');
      if (p.how === 'ah') how.append('buy' + (p.recent ? ' (none listed now: recent price)' : '') + (p.short ? ' (fewer listed than needed)' : '') + ', ', coins(p.ah), ' each');
      else if (p.how === 'vendor') how.append('from a vendor, ', coins(p.v), ' each');
      else if (p.how === 'make') how.append((p.by === 'smelt' ? 'smelt' : 'make') + (p.n !== 1 ? ' (' + num(p.n, 1) + ' a craft)' : '') + ', ', coins(p.mk), ' each');
      else how.append(el('span', 'warn-t', 'no price: not on the auction house lately'));
      line.append(how);
      if (p.c !== null) { const t = el('span', 'mat-total'); t.append(coins(p.c)); line.append(t); }
      const alt = [];
      if (p.how !== 'ah' && p.ah) alt.push(join('auction house ', coins(p.ah)));
      if (p.how !== 'make' && p.mk) alt.push(join('making it ', coins(p.mk)));
      if (p.how !== 'vendor' && p.v) alt.push(join('vendor ', coins(p.v)));
      if (alt.length) {
        const a = el('span', 'mat-alt');
        a.append('instead: ');
        alt.forEach((x, k) => { if (k) a.append(', '); a.append(x); });
        line.append(a);
      }
      li.append(line);
      if (p.p && p.how === 'make') li.append(matList(p.p));
      ul.append(li);
    });
    return ul;
  }
  // Everything to buy for one craft, after smelting and making the parts yourself.
  function rawShopping(nodes) {
    const ah = new Map(), ven = new Map();
    const walk = (list) => list.forEach((p) => {
      if (p.how === 'make' && p.p) return walk(p.p);
      const m = p.how === 'vendor' ? ven : ah;
      const cur = m.get(p.i) || { qty: 0, c: 0 };
      cur.qty += p.qty; cur.c += p.c || 0; m.set(p.i, cur);
    });
    walk(nodes);
    const box = el('div', 'shop');
    [[ah, 'Buy on the auction house'], [ven, 'Buy from a vendor']].forEach(([m, label]) => {
      if (!m.size) return;
      const p = el('p');
      p.append(el('b', null, label + ': '));
      let k = 0, tot = 0;
      m.forEach((v, i) => {
        if (k++) p.append(', ');
        p.append(qtyTxt(v.qty) + ' × ', itemName(engName(i)));
        tot += v.c;
      });
      p.append(' (', coins(tot), ')');
      box.append(p);
    });
    if (nodes.some(function frac(p) { return Math.abs(p.qty - Math.round(p.qty)) > 1e-6 || (p.how === 'make' && (p.p || []).some(frac)); })) {
      box.append(el('p', 'muted', 'Fractions are shares of a batch (one Gold Bar makes 3 Gold Power Cores, one Copper and one Tin Bar make 2 Bronze Bars): the rest carries over to your next craft.'));
    }
    return box;
  }
  function matPanel(p, info) {
    const box = el('div', 'details'), dl = el('dl'), home = FAC[S.faction];
    const way = { ah: 'Buy it in the ' + home + ' house', vendor: 'Buy it from a vendor', make: p.by === 'smelt' ? 'Smelt it' : 'Make it (Engineering)', none: 'No price' }[p.how];
    [['Cheapest way', way],
     ['In the ' + home + ' house', p.ah ? join(coins(p.ah), p.recent ? ' (recent; none listed now)' : ' each') : 'not listed'],
     ['From a vendor', p.v ? coins(p.v) : '–'],
     ['Making it yourself', p.mk ? join(coins(p.mk), ' each') : '–']].forEach(([k, val]) => {
      const kv = el('div', 'kv'), dd = el('dd'); dd.append(val); kv.append(el('dt', null, k), dd); dl.append(kv);
    });
    box.append(dl, historySection(info.id));
    return box;
  }

  function engDetails(o) {
    const home = FAC[S.faction];
    const box = el('div', 'details'), dl = el('dl');
    const share = engShare(o);
    const rows = [
      ['Materials for one craft', o.cost === null ? el('span', 'warn-t', 'unknown: no price for ' + o.missing.join(', ')) : coins(o.cost)],
      ['Makes', num(o.n, 1) + (o.n === 1 ? ' item' : ' items')],
      ['Sells for, each (' + home + ')', o.sell ? join(fineCoins(o.sell), priceNote(o.sell, o.low, o.paid, o.med)) : 'not listed or sold lately'],
      ['You get back, one craft (after 5% cut)', o.back ? coins(o.back) : '–'],
      ['Profit per craft', o.profit === null ? '–' : coins(o.profit, true)],
      ['Back per 1g', mult(o.mult)],
      ['Sold a day in the ' + home + ' house', soldTxt(o)],
      ['Listed in the ' + home + ' house', num(o.qty || 0, 0)],
      ['Paid on average', o.paid ? coins(o.paid) : 'no sales seen yet'],
      ['Your share a day', share ? (share < 1 ? 'about 1 every ' + num(1 / share, 1) + ' days' : num(share, 1) + (o.n === 1 ? '' : ' (' + num(share / o.n, 1) + (share / o.n < 1.5 ? ' craft)' : ' crafts)'))) : '–'],
      ['Profit a day', o.profitDay ? coins(o.profitDay, true) : '–'],
      ['Skill needed', o.skill === null || o.skill === undefined ? 'not known (a WoW: Forever recipe)' : String(o.skill)],
      ['How to learn it', o.how],
      ['Category', o.cat || '–'],
    ];
    rows.forEach(([k, val]) => { const kv = el('div', 'kv'), dd = el('dd'); dd.append(val); kv.append(el('dt', null, k), dd); dl.append(kv); });
    box.append(dl);
    const mh = el('h4', 'history-title', 'Materials for one craft');
    box.append(mh, matList(o.parts), rawShopping(o.parts), historySection(o.id));
    return box;
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
      if (th.closest('#eng-card')) {
        if (S.engSort === key) S.engDir = S.engDir === 'asc' ? 'desc' : 'asc'; else { S.engSort = key; S.engDir = key === 'name' || key === 'skill' || key === 'cost' ? 'asc' : 'desc'; }
        remember('engSort', S.engSort + ':' + S.engDir);
        renderEng();
      } else if (th.closest('#busy-card')) {
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
  document.querySelectorAll('[data-tab]').forEach((b) => b.addEventListener('click', () => setTab(b.dataset.tab, true)));
  window.addEventListener('hashchange', () => setTab(location.hash === '#engineering' ? 'eng' : 'trade', false));
  $('eng-skill').addEventListener('input', (e) => {
    const v = parseInt(e.target.value, 10);
    if (!(v >= 1)) return;
    S.engSkill = Math.min(300, v); remember('engSkill', S.engSkill); S.engAll = false; renderEng();
  });
  $('eng-learn').addEventListener('change', (e) => { S.engLearn = e.target.value; remember('engLearn', S.engLearn); renderEng(); });
  $('eng-school').addEventListener('change', (e) => { S.engSchool = e.target.value; remember('engSchool', S.engSchool); renderEng(); });
  $('eng-unknown').addEventListener('change', (e) => { S.engUnknown = e.target.checked; remember('engUnknown', S.engUnknown ? '1' : '0'); renderEng(); });
  $('eng-search').addEventListener('input', (e) => { S.engQuery = e.target.value.trim(); renderEng(); });
  $('eng-more').addEventListener('click', () => { S.engAll = !S.engAll; renderEng(); });
  $('busy-search').addEventListener('input', (e) => { S.busyQuery = e.target.value.trim(); renderBusy(); });
  $('chart-x').addEventListener('change', (e) => { S.chartX = e.target.value; remember('chartX', S.chartX); $('tooltip').hidden = true; renderScatter(view(), basket(view(), S.budget)); });
  $('chart-search').addEventListener('input', (e) => { S.chartQuery = e.target.value.trim(); $('tooltip').hidden = true; renderScatter(view(), basket(view(), S.budget)); });
  document.addEventListener('click', () => { $('tooltip').hidden = true; });
  $('modal-close').addEventListener('click', closeModal);
  $('modal').addEventListener('click', (e) => { if (e.target === $('modal')) closeModal(); });
  document.addEventListener('keydown', (e) => { if (e.key === 'Escape' && !$('modal').hidden) closeModal(); });
  window.addEventListener('scroll', () => { $('tooltip').hidden = true; }, { passive: true });
  let rt;
  window.addEventListener('resize', () => { clearTimeout(rt); rt = setTimeout(() => { if (S.data && S.tab === 'trade') renderScatter(view(), basket(view(), S.budget)); }, 150); });
  document.addEventListener('visibilitychange', () => { if (!document.hidden && S.loadedAt && Date.now() - S.loadedAt > 10 * 60000) load(); });
  setInterval(() => { if (S.data) renderFresh(); }, 60000);
  $('rescan').addEventListener('click', rescan);
  $('rescan').addEventListener('contextmenu', (e) => { e.preventDefault(); rescanSetup(); });   // long-press/right-click: key settings

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
  if (recall('chartX') === 'price') { S.chartX = 'price'; $('chart-x').value = 'price'; }
  const es = (recall('engSort') || '').split(':');
  if (ENG_KEYS[es[0]]) { S.engSort = es[0]; S.engDir = es[1] === 'asc' || es[1] === 'desc' ? es[1] : 'desc'; }
  const sk = parseInt(recall('engSkill'), 10); if (sk >= 1 && sk <= 300) { S.engSkill = sk; $('eng-skill').value = String(sk); }
  const el2 = recall('engLearn'); if (el2 === 'all' || el2 === 'trainer') { S.engLearn = el2; $('eng-learn').value = el2; }
  if (recall('engUnknown') === '1') { S.engUnknown = true; $('eng-unknown').checked = true; }
  const sc = recall('engSchool'); if (['any', 'gnomish', 'goblin', 'none'].indexOf(sc) >= 0) { S.engSchool = sc; $('eng-school').value = sc; }
  S.tab = location.hash === '#engineering' ? 'eng' : (location.hash ? 'trade' : (recall('tab') === 'eng' ? 'eng' : 'trade'));
  showTab();
  load();
})();
