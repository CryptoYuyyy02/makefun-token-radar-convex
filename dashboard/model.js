// The valuation model, in the browser. This is the same arithmetic lib/model.ts runs at build
// time: fit category mcap/TVL medians on the live-token anchors, fit ln(mcap) = a + b·ln(TVL) for
// the size curve, tilt each pre-token protocol by its category, then net the farm position to a
// farm / thin / skip decision. The page calls these functions on the anchors in data.js and checks
// its own numbers against the board, so the screenshot and the source cannot disagree.
(function (root) {
  'use strict';

  /** Median of a numeric array (0 for an empty one). */
  function median(nums) {
    if (!nums.length) return 0;
    var s = nums.slice().sort(function (a, b) { return a - b; });
    var m = Math.floor(s.length / 2);
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  }

  /** Fit the category multiples and the size curve from the anchors [{c,t,m}]. */
  function fitComps(anchors) {
    var byCat = {};
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      if (!(a.m > 0) || !(a.t > 0)) continue;
      var c = a.c || 'Other';
      (byCat[c] = byCat[c] || []).push(a.m / a.t);
    }
    var globalMedian = median(anchors.filter(function (a) { return a.m > 0 && a.t > 0; })
      .map(function (a) { return a.m / a.t; })) || 0.22;
    var category = {};
    for (var k in byCat) {
      var arr = byCat[k];
      var w = arr.length / (arr.length + 3);
      var m = Math.max(0.02, Math.min(3, median(arr)));
      category[k] = Math.max(0.02, Math.min(3, w * m + (1 - w) * globalMedian));
    }
    // Size curve: ln(mcap) = intercept + slope·ln(TVL), clamped to a sane slope band.
    var pts = anchors.filter(function (a) { return a.m > 0 && a.t > 0; })
      .map(function (a) { return [Math.log(a.t), Math.log(a.m)]; });
    var intercept = Math.log(globalMedian), slope = 1;
    if (pts.length >= 3) {
      var mx = 0, my = 0;
      for (var j = 0; j < pts.length; j++) { mx += pts[j][0]; my += pts[j][1]; }
      mx /= pts.length; my /= pts.length;
      var num = 0, den = 0;
      for (var q = 0; q < pts.length; q++) { num += (pts[q][0] - mx) * (pts[q][1] - my); den += (pts[q][0] - mx) * (pts[q][0] - mx); }
      slope = den > 0 ? Math.max(0.15, Math.min(1.2, num / den)) : 1;
      intercept = my - slope * mx;
    }
    return { category: category, globalMedian: globalMedian, intercept: intercept, slope: slope, anchors: pts.length };
  }

  /** The implied value of a pre-token protocol from the fitted curve, its category tilt and growth. */
  function impliedOf(tvl, category, growthPct, fit) {
    var cat = fit.category[category || 'Other'];
    if (cat === undefined) cat = fit.globalMedian;
    var curve = Math.exp(fit.intercept) * Math.pow(Math.max(1, tvl), fit.slope);
    var tilt = Math.max(0.15, Math.min(6, cat / (fit.globalMedian || 0.22)));
    var g = Math.min(120, Math.max(-60, growthPct || 0));
    var growth = g >= 0 ? 1 + Math.sqrt(g / 100) * 0.15 : 1 + (g / 100) * 0.3;
    return Math.max(1, Math.round(curve * tilt * growth));
  }

  /** Net a farm position: 0.2% airdrop pool over 500 farmers, minus gas and a 30-day allowance. */
  function netValue(tvl, implied) {
    var capital = tvl >= 5e9 ? 250 : tvl >= 1e9 ? 150 : tvl >= 1e8 ? 100 : 50;
    var share = implied * 0.002 / 500;
    var cost = (capital >= 150 ? 8 : 4) + 12;
    var net = Math.round(share - cost);
    return { verdict: net > cost ? 'farm' : net > 0 ? 'thin' : 'skip', net: net, share: Math.round(share), cost: cost };
  }

  /** Leave-one-out error and a blind rank test over the anchors, computed in the page. */
  function validate(anchors) {
    var rows = [];
    for (var i = 0; i < anchors.length; i++) {
      var a = anchors[i];
      if (a.m > 0 && a.t > 0) rows.push(a);
    }
    if (rows.length < 5) return null;
    var ae = 0;
    for (var h = 0; h < rows.length; h++) {
      var train = rows.filter(function (_, idx) { return idx !== h; });
      var f = fitComps(train);
      var pred = Math.log10(impliedOf(rows[h].t, rows[h].c, 0, f));
      ae += Math.abs(Math.log10(rows[h].m) - pred);
    }
    // Spearman between the model's implied order and the real mcap order.
    function ranks(v) {
      var order = v.map(function (x, idx) { return [x, idx]; }).sort(function (p, q) { return p[0] - q[0] || p[1] - q[1]; });
      var r = new Array(v.length);
      order.forEach(function (o, idx) { r[o[1]] = idx + 1; });
      return r;
    }
    function pearson(x, y) {
      var n = x.length, mx = 0, my = 0;
      for (var i2 = 0; i2 < n; i2++) { mx += x[i2]; my += y[i2]; }
      mx /= n; my /= n;
      var nu = 0, dx = 0, dy = 0;
      for (var i3 = 0; i3 < n; i3++) { nu += (x[i3] - mx) * (y[i3] - my); dx += (x[i3] - mx) * (x[i3] - mx); dy += (y[i3] - my) * (y[i3] - my); }
      return dx > 0 && dy > 0 ? nu / Math.sqrt(dx * dy) : 0;
    }
    var full = fitComps(rows);
    var modelOrder = ranks(rows.map(function (r) { return impliedOf(r.t, r.c, 0, full); }));
    var realOrder = ranks(rows.map(function (r) { return r.m; }));
    return { n: rows.length, looMae: ae / rows.length, spearman: pearson(modelOrder, realOrder) };
  }

  root.PrismaModel = { median: median, fitComps: fitComps, impliedOf: impliedOf, netValue: netValue, validate: validate };
})(window);
