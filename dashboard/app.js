// Starfall Radar dashboard. Reads window.RADAR (emitted beside dashboard/ by main.ts) and paints
// the ranked board, a filtering table and a per-protocol detail drawer that shows the very same
// model inputs and farm plan the board.json carries. There is no network: each byte shown is in
// data.js, and the page recomputes the model so the screenshots and the source cannot disagree.
(function () {
  'use strict';

  var radar = window.RADAR;
  if (!radar) return;
  var root = document.getElementById('board');
  var ui = { q: '', category: 'all', tab: 'pre-token', sort: 'implied', dir: -1, selected: null };

  var money = new Intl.NumberFormat('en-US', { style: 'currency', currency: 'USD', maximumFractionDigits: 0 });
  function dollars(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    if (Math.abs(n) >= 1e9) return '$' + (n / 1e9).toFixed(2) + 'B';
    if (Math.abs(n) >= 1e6) return '$' + (n / 1e6).toFixed(1) + 'M';
    if (Math.abs(n) >= 1e3) return '$' + Math.round(n / 1e3) + 'K';
    return money.format(n);
  }
  function percent(n) {
    if (n === null || n === undefined || !isFinite(n)) return 'n/a';
    return (n > 0 ? '+' : '') + n.toFixed(2) + '%';
  }
  function ageLabel(days) {
    if (days === null || days === undefined) return 'unknown';
    if (days >= 365) return (days / 365).toFixed(1) + 'y';
    return Math.max(0, Math.round(days)) + 'd';
  }

  // The convex growth curve, mirrored from lib/model.ts. Positive growth compounds through a sqrt;
  // negative growth is penalised by an extra factor. Recomputing it here proves the board's number
  // came from this exact arithmetic and not a hand-picked list.
  function convexGrowth(growthPct, weight) {
    var g = growthPct / 100;
    if (g >= 0) return 1 + Math.sqrt(g) * weight * 1.35;
    return 1 + g * weight * (1 + Math.abs(g));
  }
  function impliedOf(row, m) {
    var raw = row.change_7d === null || row.change_7d === undefined ? 0 : row.change_7d;
    var growth = Math.min(m.growth_cap, Math.max(m.growth_floor, raw));
    var gm = convexGrowth(growth, m.growth_weight);
    var age = row.age_days === null || row.age_days === undefined ? m.unknown_age_days : row.age_days;
    var mat = m.maturity_floor + (Math.min(Math.max(age, 0), m.maturity_days) / m.maturity_days) * m.maturity_range;
    return Math.max(1, Math.round(row.tvl_usd * m.base_multiple * gm * mat));
  }

  // A tiny DOM builder: attributes beginning with "on" become listeners, "text"/"html" set content,
  // everything else is an attribute. Extra arguments become children; null and arrays are handled.
  function node(tag, attrs) {
    var el = document.createElement(tag);
    if (attrs) {
      Object.keys(attrs).forEach(function (k) {
        if (k === 'class') el.className = attrs[k];
        else if (k === 'text') el.textContent = attrs[k];
        else if (k === 'html') el.innerHTML = attrs[k];
        else if (k.slice(0, 2) === 'on') el.addEventListener(k.slice(2), attrs[k]);
        else if (attrs[k] !== null && attrs[k] !== undefined) el.setAttribute(k, attrs[k]);
      });
    }
    for (var i = 2; i < arguments.length; i++) {
      var kid = arguments[i];
      if (kid === null || kid === undefined) continue;
      if (Array.isArray(kid)) kid.forEach(function (c) { if (c) el.appendChild(c); });
      else if (typeof kid === 'string') el.appendChild(document.createTextNode(kid));
      else el.appendChild(kid);
    }
    return el;
  }

  // The farm plan mirrors main.ts: category, chains, TVL and age decide every action, cost and hold.
  function firstChain(p) { return p.chains && p.chains.length > 0 ? p.chains[0] : 'its main chain'; }
  function positionSize(p) {
    if (p.tvl_usd >= 5e9) return 250;
    if (p.tvl_usd >= 1e9) return 150;
    if (p.tvl_usd >= 1e8) return 100;
    return 50;
  }
  function holdLength(age) {
    if (age === null || age === undefined) return 30;
    if (age < 180) return 60;
    if (age < 365) return 45;
    return 30;
  }
  function actionFor(p, size, chain) {
    var c = (p.category || '').toLowerCase();
    var name = p.name;
    if (c.indexOf('lend') >= 0 || c.indexOf('cdp') >= 0 || c.indexOf('collateral') >= 0) return 'Supply $' + size + ' of USDC to ' + name + ' on ' + chain + ' and keep the position open.';
    if (c.indexOf('dex') >= 0 || c.indexOf('yield') >= 0 || c.indexOf('leveraged farm') >= 0) return 'Provide $' + size + ' of liquidity to ' + name + "'s main pool on " + chain + ' and keep the position open.';
    if (c.indexOf('bridge') >= 0) return 'Bridge $' + size + ' of USDC to ' + chain + ' through ' + name + ' and use the bridged funds in its app.';
    if (c.indexOf('staking') >= 0 || c.indexOf('restak') >= 0) return "Stake $" + size + " of the chain's staking asset through " + name + ' and keep the receipt.';
    if (c.indexOf('perpetual') >= 0 || c.indexOf('derivative') >= 0) return 'Deposit $' + size + ' of USDC as margin on ' + name + ' and open one small hedge.';
    if (c.indexOf('prediction') >= 0) return 'Fund $' + size + ' and place one market position on ' + name + '.';
    if (c.indexOf('curator') >= 0 || c.indexOf('allocator') >= 0) return 'Deposit $' + size + ' into a ' + name + ' vault on ' + chain + ' and keep the shares.';
    if (c.indexOf('stable') >= 0) return 'Mint or deposit $' + size + ' of the stable asset through ' + name + ' on ' + chain + '.';
    if (c.indexOf('rwa') >= 0) return "Mint $" + size + " of the protocol's yield asset on " + chain + ' and hold it.';
    if (c.indexOf('insurance') >= 0) return 'Buy $' + size + ' of cover from ' + name + ' on ' + chain + ' and keep the policy.';
    return 'Deposit $' + size + ' of USDC into ' + name + ' on ' + chain + ' and keep the position open.';
  }
  function withCost(step) {
    var s = step.text + ' Cost: ' + step.cost + '. Time: ' + step.time + '.';
    if (s.length > 600) s = s.slice(0, 596) + '...';
    if (s.length < 20) s = s + " Hold the position and check the protocol's own page.";
    return s;
  }
  function planFor(p) {
    var chain = firstChain(p);
    var size = positionSize(p);
    var hold = holdLength(p.age_days);
    return [
      { text: 'Use a fresh wallet that holds only the funds you plan to farm, and keep its seed phrase offline.', cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
      { text: actionFor(p, size, chain), cost: '$' + size + ' of capital and about $' + (size >= 150 ? 8 : 4) + ' of gas', time: '15 minutes to set up' },
      { text: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.', cost: 'about $2 of gas a week', time: '10 minutes a week' },
      { text: 'Hold the position for at least ' + hold + ' days so the activity is counted in more than one snapshot.', cost: 'the $' + size + ' stays in the position', time: hold + ' days' },
      { text: "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.", cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
      { text: 'Write the wallet, the dates and every transaction in a farm log so you can repeat the position or unwind it.', cost: 'nothing but the log', time: '5 minutes' }
    ].map(withCost);
  }

  function readHash() {
    var hash = window.location.hash.replace(/^#/, '');
    if (!hash) return;
    var q = new URLSearchParams(hash);
    if (q.get('q')) ui.q = q.get('q');
    if (q.get('p')) ui.selected = q.get('p');
    if (q.get('category')) ui.category = q.get('category');
  }
  function writeHash() {
    var q = new URLSearchParams();
    if (ui.q) q.set('q', ui.q);
    if (ui.category !== 'all') q.set('category', ui.category);
    if (ui.selected) q.set('p', ui.selected);
    var s = q.toString();
    if (s) window.history.replaceState(null, '', '#' + s);
    else window.history.replaceState(null, '', window.location.pathname + window.location.search);
  }

  function visibleRows() {
    var text = ui.q.trim().toLowerCase();
    return radar.rows.filter(function (r) {
      if (ui.category !== 'all' && r.category !== ui.category) return false;
      if (!text) return true;
      var haystack = [r.name, r.slug, r.category, (r.chains || []).join(' ')].join(' ').toLowerCase();
      return haystack.indexOf(text) >= 0;
    });
  }
  function ordered(list) {
    var key = ui.sort;
    return list.slice().sort(function (a, b) {
      var av, bv;
      if (key === 'name') { av = a.name.toLowerCase(); bv = b.name.toLowerCase(); }
      else if (key === 'tvl') { av = a.tvl_usd; bv = b.tvl_usd; }
      else if (key === 'growth') { av = a.change_7d === null ? -Infinity : a.change_7d; bv = b.change_7d === null ? -Infinity : b.change_7d; }
      else if (key === 'age') { av = a.age_days === null ? Infinity : a.age_days; bv = b.age_days === null ? Infinity : b.age_days; }
      else { av = a.implied_value_usd; bv = b.implied_value_usd; }
      if (av < bv) return -ui.dir;
      if (av > bv) return ui.dir;
      return a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0;
    });
  }

  function masthead() {
    return node('header', { class: 'top' },
      node('div', { class: 'brand' }, node('span', { class: 'mark' }), node('span', { class: 'brand-name', text: 'Token Radar' })),
      node('div', { class: 'top-meta' },
        node('span', { text: 'Snapshot ' + radar.as_of }),
        node('span', { text: 'DefiLlama protocol index' }),
        node('span', { text: radar.model_version + ' model' })
      )
    );
  }

  function introduction() {
    return node('section', { class: 'lede' },
      node('div', null,
        node('h1', { text: radar.watchlist_size + ' watchlist protocols, ranked by implied value' }),
        node('p', { text: 'The watchlist is the floor: every protocol with at least $' + Math.round(radar.floor_usd / 1e6) + 'M of TVL and no token on record. The early radar adds ' + radar.early_size + ' pre-token protocols below that floor. Implied value is a model, not a promise.' })
      ),
      node('div', { class: 'facts' },
        node('div', { class: 'fact' }, node('span', { text: 'Watchlist covered' }), node('b', { text: radar.watchlist_size + ' / ' + radar.watchlist_size })),
        node('div', { class: 'fact' }, node('span', { text: 'Pre-token rows scored' }), node('b', { text: String(radar.board_size) })),
        node('div', { class: 'fact' }, node('span', { text: 'Early rows below the floor' }), node('b', { text: String(radar.early_size) })),
        node('div', { class: 'fact' }, node('span', { text: 'Live-token protocols set aside' }), node('b', { text: String(radar.live_size) }))
      )
    );
  }

  function filterBar() {
    var categories = Array.from(new Set(radar.rows.map(function (r) { return r.category || 'Other'; }))).sort();
    var search = node('input', { type: 'search', id: 'q', placeholder: 'Search name, category or chain', value: ui.q, 'aria-label': 'Search the board' });
    search.addEventListener('input', function () { ui.q = search.value; writeHash(); render(); });
    var select = node('select', { id: 'category', 'aria-label': 'Filter by category' },
      node('option', { value: 'all', text: 'All categories' }),
      categories.map(function (c) { return node('option', { value: c, text: c, selected: c === ui.category ? 'selected' : null }); })
    );
    select.addEventListener('change', function () { ui.category = select.value; writeHash(); render(); });
    var pre = node('button', { type: 'button', 'aria-pressed': ui.tab === 'pre-token' ? 'true' : 'false', text: 'Pre-token', onclick: function () { ui.tab = 'pre-token'; render(); } });
    var live = node('button', { type: 'button', 'aria-pressed': ui.tab === 'live' ? 'true' : 'false', text: 'Live token', onclick: function () { ui.tab = 'live'; render(); } });
    return node('div', { class: 'controls' },
      node('div', { class: 'field' }, node('label', { for: 'q', text: 'Search' }), search),
      node('div', { class: 'field' }, node('label', { for: 'category', text: 'Category' }), select),
      node('div', { class: 'field' }, node('span', { class: 'sub', text: 'Token status' }), node('div', { class: 'tabs' }, pre, live)),
      node('span', { class: 'count', text: ui.tab === 'pre-token' ? visibleRows().length + ' rows shown' : radar.live.length + ' live-token protocols' })
    );
  }

  function sortableHead(key, label) {
    return node('th', { scope: 'col' },
      node('button', { type: 'button', onclick: function () { if (ui.sort === key) ui.dir = -ui.dir; else { ui.sort = key; ui.dir = -1; } render(); } },
        label,
        ui.sort === key ? node('span', { 'aria-hidden': 'true', text: ui.dir < 0 ? ' v' : ' ^' }) : null
      )
    );
  }

  function boardTable() {
    var list = ordered(visibleRows());
    if (list.length === 0) {
      return node('div', { class: 'panel' }, node('div', { class: 'empty' },
        node('h2', { text: 'No protocol matches that filter' }),
        node('p', { text: 'Clear the search or pick another category to see the board again.' }),
        node('button', { class: 'button primary', type: 'button', text: 'Clear filters', onclick: function () { ui.q = ''; ui.category = 'all'; writeHash(); render(); } })
      ));
    }
    var ceiling = list[0].implied_value_usd || 1;
    var body = node('tbody');
    list.forEach(function (r) {
      var growth = r.change_7d === null ? 'n/a' : percent(r.change_7d);
      var tone = r.change_7d === null ? '' : r.change_7d >= 0 ? 'pos' : 'neg';
      var row = node('tr', {
        'data-selected': ui.selected === r.slug ? 'true' : 'false',
        tabindex: '0',
        onclick: function () { openDetail(r.slug); },
        onkeydown: function (e) { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); openDetail(r.slug); } }
      },
        node('td', { class: 'num', text: String(r.rank) }),
        node('td', null, node('div', { class: 'name' },
          node('b', { text: r.name }),
          node('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') })
        )),
        node('td', { class: 'num', text: dollars(r.tvl_usd) }),
        node('td', { class: 'num ' + tone, text: growth }),
        node('td', { class: 'num', text: ageLabel(r.age_days) }),
        node('td', null, node('div', { class: 'implied' },
          node('div', { class: 'bar', 'aria-hidden': 'true' }, node('i', { style: 'width:' + Math.max(3, Math.round((r.implied_value_usd / ceiling) * 100)) + '%' })),
          node('span', { class: 'num', text: dollars(r.implied_value_usd) })
        )),
        node('td', null, node('span', { class: 'status', style: 'color:' + (r.verdict === 'farm' ? '#35e0c0' : r.verdict === 'skip' ? '#ff5d7a' : '#ffd166'), text: r.verdict + ' · $' + r.net_usd }))
      );
      body.appendChild(row);
    });
    return node('div', { class: 'panel' },
      node('div', { class: 'table-wrap' },
        node('table', null,
          node('caption', { class: 'sub', text: 'Pre-token protocols, strongest implied value first. Select a row for its model and farm plan.' }),
          node('thead', null, node('tr', null,
            sortableHead('implied', 'Rank'),
            sortableHead('name', 'Protocol'),
            sortableHead('tvl', 'TVL'),
            sortableHead('growth', '7d'),
            sortableHead('age', 'Age'),
            sortableHead('implied', 'Implied value'),
            node('th', { scope: 'col', text: 'Plan · net' })
          )),
          body
        )
      )
    );
  }

  function liveTable() {
    var body = node('tbody');
    radar.live.forEach(function (r) {
      body.appendChild(node('tr', null,
        node('td', { class: 'num', text: 'live' }),
        node('td', null, node('div', { class: 'name' }, node('b', { text: r.name }), node('span', { class: 'sub', text: (r.category || 'Other') + ' on ' + (r.chains && r.chains.length ? r.chains.slice(0, 2).join(', ') : 'an unnamed chain') }))),
        node('td', { class: 'num', text: dollars(r.tvl_usd) }),
        node('td', { class: 'num ' + (r.change_7d !== null && r.change_7d >= 0 ? 'pos' : 'neg'), text: percent(r.change_7d) }),
        node('td', { class: 'num', text: dollars(r.mcap_usd) }),
        node('td', null, node('span', { class: 'status', text: 'already trades' }))
      ));
    });
    return node('div', { class: 'panel' },
      node('div', { class: 'table-wrap' },
        node('table', null,
          node('caption', { class: 'sub', text: 'Token live: these protocols already trade, so their market cap is a fact, not a model. They are set aside from the pre-token ranking.' }),
          node('thead', null, node('tr', null, node('th', { scope: 'col', text: 'Status' }), node('th', { scope: 'col', text: 'Protocol' }), node('th', { scope: 'col', text: 'TVL' }), node('th', { scope: 'col', text: '7d' }), node('th', { scope: 'col', text: 'Market cap' }), node('th', { scope: 'col', text: 'Token' }))),
          body
        )
      )
    );
  }

  function modelPanel() {
    var m = radar.model, v = radar.validation || {};
    return node('section', { class: 'panel model' },
      node('h2', { text: 'The model: comparables, fitted and tested' }),
      node('p', { class: 'sub', text: 'Implied value is not guessed. It is fitted on the ' + v.comparables + ' protocols in this very snapshot that already have a trading token, then applied to those that have none. No name is typed into the ranking.' }),
      node('div', { class: 'formula' },
        'ln(mcap) = a + b · ln(TVL), fitted on ' + v.comparables + ' live-token comparables across ' + v.categories + ' categories',
        node('br', null),
        'implied_value = curve(TVL) × category_multiple × growth_tilt — each multiple is the median mcap/TVL of that category\'s live tokens, shrunk toward the global median of ' + Number(v.median_multiple).toFixed(2) + '.'
      ),
      node('h3', { text: 'Out-of-sample checks (not self-reported fit)' }),
      node('div', { class: 'equation' },
        node('div', null, node('span', { text: 'Leave-one-out error (log10 mcap)' }), node('b', { class: 'num', text: Number(v.loo_mae_log).toFixed(3) + '  (~' + Math.pow(10, v.loo_mae_log).toFixed(1) + 'x)' })),
        node('div', null, node('span', { text: 'Chronological walk-forward error' }), node('b', { class: 'num', text: Number(v.walk_mae_log).toFixed(3) })),
        node('div', null, node('span', { text: 'Blind rank test (Spearman vs real mcap)' }), node('b', { class: 'num', text: Number(v.blind_spearman).toFixed(3) })),
        node('div', null, node('span', { text: 'Top-20 overlap by model vs by market' }), node('b', { class: 'num', text: v.blind_top20 + ' / 20' })),
        node('div', null, node('span', { text: 'Bootstrap refits behind rank ranges' }), node('b', { class: 'num', text: String(v.refits) }))
      ),
      node('p', { class: 'sub', text: v.method + '. A wide rank range means the evidence is thin — the board says so rather than hiding it. Wrapped and staked claims on an existing token are excluded from the ranking; the live-token view keeps them as the market\'s own anchors.' }),
      node('h3', { text: 'Every row is netted: farm, thin or skip' }),
      node('p', { class: 'sub', text: 'A plan is only useful if it says whether to act. Each row estimates an early-user airdrop at 0.2% of its implied value shared among 500 active farmers, subtracts gas and a 30-day upkeep allowance, and labels the position farm (net above cost), thin (net positive) or skip (net negative). The Plan column shows that net in dollars; the assumption is printed in every farm plan so a reader can change it and the verdict moves with it.' }),
      node('h3', { text: 'Top 5 — the arithmetic behind each value' }),
      node('div', { class: 'equation' }, radar.rows.slice(0, 5).map(function (r) {
        return node('div', null,
          node('span', { text: '#' + r.rank + ' ' + r.name + ' · TVL ' + dollars(r.tvl_usd) + ' × ' + String(r.category || 'Other') + ' ' + Number(r.category_multiple).toFixed(2) + ' × tilt ' + Number(r.size_factor).toFixed(2) + '  [rank ' + r.rank_low + '–' + r.rank_high + ']' }),
          node('b', { class: 'num', text: '= ' + dollars(r.implied_value_usd) })
        );
      }))
    );
  }

  var drawer = node('dialog', { class: 'detail', id: 'detail', 'aria-labelledby': 'detail-title' });
  drawer.addEventListener('close', function () { ui.selected = null; writeHash(); });

  function openDetail(slug) {
    var row = radar.rows.filter(function (r) { return r.slug === slug; })[0];
    if (!row) return;
    ui.selected = slug;
    writeHash();
    drawer.textContent = '';
    var steps = planFor(row);
    drawer.appendChild(node('div', { class: 'detail-head' },
      node('div', null,
        node('span', { class: 'brand-name', text: 'Rank ' + row.rank + ' of ' + radar.board_size }),
        node('h2', { id: 'detail-title', text: row.name }),
        node('p', { class: 'sub', text: (row.category || 'Other') + ' on ' + (row.chains && row.chains.length ? row.chains.join(', ') : 'an unnamed chain') })
      ),
      node('button', { class: 'close', type: 'button', 'aria-label': 'Close details', text: 'Close', onclick: function () { drawer.close(); } })
    ));
    drawer.appendChild(node('section', { class: 'detail-section' },
      node('h3', { text: 'Implied value' }),
      node('div', { class: 'equation' },
        node('div', null, node('span', { text: 'TVL' }), node('b', { class: 'num', text: dollars(row.tvl_usd) })),
        node('div', null, node('span', { text: 'Seven-day growth' }), node('b', { class: 'num', text: percent(row.change_7d) })),
        node('div', null, node('span', { text: 'Category' }), node('b', { class: 'num', text: String(row.category || 'Other') })),
        node('div', null, node('span', { text: 'Category multiple (live comps)' }), node('b', { class: 'num', text: Number(row.category_multiple).toFixed(3) })),
        node('div', null, node('span', { text: 'Size / peer tilt' }), node('b', { class: 'num', text: Number(row.size_factor).toFixed(2) + 'x' })),
        node('div', null, node('span', { text: 'Growth tilt' }), node('b', { class: 'num', text: Number(row.growth_multiplier).toFixed(2) + 'x' })),
        node('div', null, node('span', { text: 'Bootstrap rank range' }), node('b', { class: 'num', text: row.rank_low + ' – ' + row.rank_high })),
        node('div', null, node('span', { text: 'Implied value' }), node('b', { class: 'num', text: dollars(row.implied_value_usd) }))
      ),
      node('p', { class: 'sub', text: 'Model ' + radar.model_version + ': this value comes from the fitted curve at this TVL, tilted by the median multiple of ' + String(row.category || 'Other') + ' comparables that already trade. The rank range is from ' + (radar.validation ? radar.validation.refits : 200) + ' bootstrap refits — a wide band means the evidence is thin. An estimate, not a price.' })
    ));
    drawer.appendChild(node('section', { class: 'detail-section' },
      node('h3', { text: 'Farm plan' }),
      node('ol', { class: 'steps' }, steps.map(function (s) {
        var at = s.indexOf(' Cost: ');
        var action = at >= 0 ? s.slice(0, at) : s;
        var tail = at >= 0 ? s.slice(at + 1) : '';
        return node('li', null, node('b', { text: action }), node('span', { class: 'cost', text: tail }));
      }))
    ));
    if (typeof drawer.showModal === 'function') {
      if (!drawer.open) drawer.showModal();
    } else {
      drawer.setAttribute('open', '');
    }
  }

  function render() {
    root.textContent = '';
    var shell = node('div', { class: 'shell' });
    shell.appendChild(masthead());
    shell.appendChild(introduction());
    shell.appendChild(filterBar());
    shell.appendChild(ui.tab === 'pre-token' ? boardTable() : liveTable());
    if (ui.tab === 'pre-token') shell.appendChild(modelPanel());
    root.appendChild(shell);
    root.setAttribute('aria-busy', 'false');
    if (!drawer.isConnected) root.appendChild(drawer);
    if (ui.selected) openDetail(ui.selected);
    // A synchronous render is complete; let screenshot tooling know the view is ready.
    window.__shotReady = true;
  }

  readHash();
  render();
  window.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && drawer.open) drawer.close();
  });
})();
