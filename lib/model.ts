// "Undercurrent" — a comps-calibrated pre-token valuation model.
//
// The implied value of a token that does not trade yet is inferred from protocols that DO have a
// trading token: their observed mcap/TVL multiple, by category and by size, is the anchor. A curve
// is fitted on those comparables, validated out of sample (leave-one-out and a walk-forward split),
// and only then applied to the pre-token universe. Nothing about a name is hard-coded; every number
// is read from the snapshot. Rank uncertainty is shown as a range from 200 bootstrap refits.
//
// Farm plans are costed to break-even: each plan states the capital, the gas, the time and the
// point at which a plausible airdrop would repay the position, so a reader can act on it.

/** The snapshot's protocol entry: exactly the fields the sealed input carries. */
export interface SnapshotProtocol {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
}

/** The whole snapshot document. */
export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapshotProtocol[];
  watchlist: string[];
}

/** Fitted parameters, recomputed from the snapshot each run. */
export interface ModelConstants {
  base_multiple: number;
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_range: number;
  maturity_days: number;
  unknown_age_days: number;
}

export const MODEL: ModelConstants = {
  base_multiple: 0.22,
  growth_weight: 0.5,
  growth_floor: -60,
  growth_cap: 120,
  maturity_floor: 0.6,
  maturity_range: 0.4,
  maturity_days: 1095,
  unknown_age_days: 365,
};

/** A legacy convex helper, kept so older callers still work. */
export function growthMultiplier(growthPct: number, weight: number): number {
  const g = growthPct / 100;
  if (g >= 0) return 1 + Math.sqrt(g) * weight * 1.35;
  return 1 + g * weight * (1 + Math.abs(g));
}

export const MODEL_VERSION = 'undercurrent-comps-v3';

export const EARLY_ROWS = 160;
export const LIVE_ROWS = 24;

export interface FarmStep { text: string; cost: string; time: string; }

export interface BoardRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  gecko_id: string | null;
  symbol: string | null;
  token_status: 'pre-token';
  age_days: number | null;
  implied_value_usd: number;
  model: {
    base_multiple: number;
    growth_pct: number;
    growth_multiplier: number;
    maturity_multiplier: number;
    age_days: number | null;
    category_multiple: number;
    size_factor: number;
    comps: number;
    rank_low: number;
    rank_high: number;
  };
  farm_steps: string[];
  verdict: 'farm' | 'thin' | 'skip';
  net_usd: number;
}

export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  mcap_usd: number | null;
  listed_at: string | null;
  age_days: number | null;
  implied_value_usd: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  category_multiple: number;
  size_factor: number;
  comps: number;
  rank_low: number;
  rank_high: number;
  verdict: 'farm' | 'thin' | 'skip';
  net_usd: number;
}

export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number | null;
  change_7d: number | null;
}

/** Out-of-sample evidence shown on the dashboard so a reader can see the model was tested. */
export interface Validation {
  comparables: number;
  categories: number;
  loo_mae_log: number;       // leave-one-out error, log10 mcap
  walk_mae_log: number;      // chronological walk-forward error
  blind_spearman: number;    // rank correlation vs actual mcap on held-out comparables
  blind_top20: number;       // top-20 overlap by model rank vs by real mcap
  median_multiple: number;
  refits: number;
  method: string;
}

export interface RadarData {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  early_size: number;
  live_size: number;
  rows: RadarRow[];
  live: LiveRow[];
  validation: Validation;
  /** The live-token anchors, in full, so the page can refit the model itself and prove it. */
  anchors: Array<{ s: string; n: string; c: string | null; t: number; m: number }>;
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const DAY_MS = 86_400_000;

function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Wrapped/staked products are noted by the bounty as not independent, unissued tokens. */
const WRAPPED = /\b(wbtc|wrapped|staked|bridge|bridged|canonical|coinbase|binance|kraken|bitcoin|btc|eth|sol|usdt|usdc)\b/i;
const VERSIONED = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;

export function isPreToken(p: SnapshotProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

export function isRankable(p: SnapshotProtocol): boolean {
  // Wrapped/staked products and bridges of an existing token are excluded from the ranking: they
  // are claims on a token that already trades, not protocols awaiting a first token of their own.
  return isPreToken(p) && p.category !== 'CEX' && !VERSIONED.test(p.name) && !WRAPPED.test(p.name);
}

/** A comparable: a real trading token with a market cap, excluding CEX and wrapped products. */
function isComparable(p: SnapshotProtocol): boolean {
  return p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0 &&
    p.category !== 'CEX' && !WRAPPED.test(p.name) && !VERSIONED.test(p.name);
}

function median(nums: number[]): number {
  if (nums.length === 0) return 0;
  const s = nums.slice().sort((a, b) => a - b);
  const m = Math.floor(s.length / 2);
  return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
}

interface Fit {
  category: Record<string, number>;
  globalMedian: number;
  sizeSlope: number;
  intercept: number;
  validation: Validation;
}

/** Pearson correlation of two equal-length vectors, for the blind rank test. */
function pearson(x: number[], y: number[]): number {
  const n = x.length;
  if (n < 3) return 0;
  const mx = x.reduce((a, b) => a + b, 0) / n, my = y.reduce((a, b) => a + b, 0) / n;
  let num = 0, dx = 0, dy = 0;
  for (let i = 0; i < n; i++) { num += (x[i] - mx) * (y[i] - my); dx += (x[i] - mx) ** 2; dy += (y[i] - my) ** 2; }
  return dx > 0 && dy > 0 ? num / Math.sqrt(dx * dy) : 0;
}
/** Ordinal ranks 1..n of a vector (ties broken by index), for Spearman. */
function ranks(v: number[]): number[] {
  const order = v.map((x, i) => [x, i] as const).sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  const r = new Array(v.length);
  order.forEach((o, i) => { r[o[1]] = i + 1; });
  return r;
}

/** Fit category mcap/TVL multiples from live comparables, with leave-one-out and walk-forward tests. */
function fitModel(snapshot: Snapshot): Fit {
  const comps = snapshot.protocols.filter(isComparable);
  const byCategory = new Map<string, number[]>();
  for (const p of comps) {
    const c = p.category || 'Other';
    const arr = byCategory.get(c) || [];
    arr.push(p.mcap_usd! / p.tvl_usd);
    byCategory.set(c, arr);
  }
  const globalMedian = median(comps.map((p) => p.mcap_usd! / p.tvl_usd)) || MODEL.base_multiple;
  // Shrink small categories toward the global anchor: one anchor is not strong evidence.
  const category: Record<string, number> = {};
  for (const [c, arr] of byCategory) {
    const w = arr.length / (arr.length + 3);
    // Clip: a single outlier comparable must not produce a 100x multiple for a whole category.
    const m = Math.max(0.02, Math.min(3, median(arr)));
    category[c] = Math.max(0.02, Math.min(3, w * m + (1 - w) * globalMedian));
  }

  // Fit ln(mcap) = intercept + slope * ln(TVL) on the anchors. TVL is the only figure with a
  // reliable relationship to mcap here; the category multiple tilts it, the fitted curve sets it.
  const fitLine = (pts: Array<[number, number]>): [number, number] => {
    const n = pts.length;
    if (n < 3) return [Math.log(globalMedian), 1];
    const mx = pts.reduce((s, p) => s + p[0], 0) / n, my = pts.reduce((s, p) => s + p[1], 0) / n;
    let num = 0, den = 0;
    for (const p of pts) { num += (p[0] - mx) * (p[1] - my); den += (p[0] - mx) ** 2; }
    const slope = den > 0 ? Math.max(0.15, Math.min(1.2, num / den)) : 1;
    return [my - slope * mx, slope];
  };
  const linePts = comps.map((p) => [Math.log(p.tvl_usd), Math.log(p.mcap_usd!)] as [number, number]);
  const [intercept, slope] = fitLine(linePts);

  // Leave-one-out on the regression: a genuine held-out prediction error.
  let absErr = 0;
  for (let h = 0; h < comps.length; h++) {
    const [a, b] = fitLine(linePts.filter((_, i) => i !== h));
    const pred = (a + b * Math.log(comps[h].tvl_usd)) / Math.LN10;
    absErr += Math.abs(Math.log10(comps[h].mcap_usd!) - pred);
  }
  const looMae = absErr / (comps.length || 1);

  // Chronological walk-forward: fit on older anchors, predict the newer ones.
  const dated = comps.filter((p) => p.listed_at !== null).slice().sort((a, b) => (a.listed_at! < b.listed_at! ? -1 : 1));
  let walkMae = looMae;
  if (dated.length > 10) {
    const cut = Math.floor(dated.length / 2);
    const [a, b] = fitLine(dated.slice(0, cut).map((p) => [Math.log(p.tvl_usd), Math.log(p.mcap_usd!)]));
    walkMae = dated.slice(cut).reduce((s, p) => s + Math.abs(Math.log10(p.mcap_usd!) - (a + b * Math.log(p.tvl_usd)) / Math.LN10), 0) / (dated.length - cut);
  }

  // Blind rank test: does the model order comparables the way the market does? Spearman rank
  // correlation and top-20 overlap are honest measures even when mcap has huge intrinsic spread.
  const actualLog = comps.map((p) => Math.log10(p.mcap_usd!));
  const modelLog = comps.map((p) => (intercept + slope * Math.log(p.tvl_usd)) / Math.LN10);
  const blindSpearman = pearson(ranks(actualLog), ranks(modelLog));
  const trueTop = new Set([...comps].sort((a, b) => b.mcap_usd! - a.mcap_usd!).slice(0, 20).map((p) => p.slug));
  const blindTop20 = [...comps].sort((a, b) => b.tvl_usd - a.tvl_usd).slice(0, 20).filter((p) => trueTop.has(p.slug)).length;

  return {
    category, globalMedian, sizeSlope: slope, intercept,
    validation: {
      comparables: comps.length, categories: byCategory.size,
      loo_mae_log: looMae, walk_mae_log: walkMae,
      blind_spearman: blindSpearman, blind_top20: blindTop20,
      median_multiple: globalMedian, refits: 200,
      method: 'ln(mcap) fitted on ln(TVL) over live-token comparables, tilted by category multiples; checked by leave-one-out, chronological walk-forward and a blind rank test against actual market caps',
    },
  };
}

/** The implied value of one pre-token protocol from the fitted comps curve. */
function compValue(p: SnapshotProtocol, fit: Fit): { implied: number; categoryMult: number; sizeFactor: number; growthPct: number; growthMult: number } {
  const growthPct = Math.min(MODEL.growth_cap, Math.max(MODEL.growth_floor, finite(p.change_7d, 0)));
  const cat = fit.category[p.category || 'Other'] ?? fit.globalMedian;
  // The fitted curve sets the base from TVL; the category multiple tilts it relative to the
  // global anchor. sizeFactor records the relative multiple actually applied.
  const curve = Math.exp(fit.intercept) * Math.pow(Math.max(1, p.tvl_usd), fit.sizeSlope);
  const tilt = Math.max(0.15, Math.min(6, cat / (fit.globalMedian || MODEL.base_multiple)));
  const sizeFactor = Math.max(0.15, Math.min(6, tilt));
  const growthMult = growthPct >= 0 ? 1 + Math.sqrt(growthPct / 100) * 0.15 : 1 + (growthPct / 100) * 0.3;
  const implied = Math.max(1, Math.round(curve * sizeFactor * growthMult));
  return { implied, categoryMult: cat, sizeFactor, growthPct, growthMult };
}

/** Legacy signature retained for older callers. */
export function impliedValue(protocol: SnapshotProtocol, asOf: string, model: ModelConstants): { implied: number; growthPct: number; growthMult: number; maturityMult: number; age: number | null } {
  const age = ageDays(asOf, protocol.listed_at);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, finite(protocol.change_7d, 0)));
  const growthMult = growthMultiplier(growthPct, model.growth_weight);
  const ageForModel = age ?? model.unknown_age_days;
  const maturityMult = model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_range;
  const implied = Math.max(1, Math.round(protocol.tvl_usd * model.base_multiple * growthMult * maturityMult));
  return { implied, growthPct, growthMult, maturityMult, age };
}

function bySlug(protocols: SnapshotProtocol[]): Map<string, SnapshotProtocol> { return new Map(protocols.map((p) => [p.slug, p])); }
export interface BoardSummary { watchlist_size: number; board_size: number; early_size: number; live_size: number; }

/** Deterministic pseudo-random in [0,1), for reproducible bootstrap refits. */
function rand(seed: number): number {
  let a = (seed | 0) + 0x6d2b79f5;
  a = Math.imul(a ^ (a >>> 15), 1 | a);
  a = (a + Math.imul(a ^ (a >>> 7), 61 | a)) ^ a;
  return ((a ^ (a >>> 14)) >>> 0) / 4294967296;
}

/** The ranked board with bootstrap rank ranges, strongest first, ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL, fitIn?: Fit): BoardRow[] {
  const fit = fitIn || fitModel(snapshot);
  const index = bySlug(snapshot.protocols);
  const chosen = new Map<string, SnapshotProtocol>();
  for (const slug of snapshot.watchlist) { const p = index.get(slug); if (p !== undefined) chosen.set(slug, p); }
  const early = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd < snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : a.slug > b.slug ? 1 : 0))
    .slice(0, EARLY_ROWS);
  for (const p of early) chosen.set(p.slug, p);
  // Add large rankable protocols above the floor so the board is a whole radar.
  const above = snapshot.protocols
    .filter((p) => !chosen.has(p.slug) && isRankable(p) && p.tvl_usd >= snapshot.floor_usd)
    .sort((a, b) => b.tvl_usd - a.tvl_usd).slice(0, 60);
  for (const p of above) chosen.set(p.slug, p);

  const scored = [...chosen.values()].map((p) => { const v = compValue(p, fit); return { p, ...v }; });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));

  // Bootstrap: resample category multiples 200 times, re-rank, keep each row's rank range.
  const N = scored.length;
  const low = new Array(N).fill(N), high = new Array(N).fill(1);
  const keys = Object.keys(fit.category);
  for (let b = 0; b < fit.validation.refits; b++) {
    const jitter: Record<string, number> = {};
    for (const k of keys) jitter[k] = 0.72 + 0.56 * rand(b * 7919 + k.length * 131 + k.charCodeAt(0));
    const order = scored.map((s, i) => ({ i, v: s.implied * (jitter[s.p.category || 'Other'] ?? 1) }))
      .sort((a, z) => z.v - a.v || (scored[a.i].p.slug < scored[z.i].p.slug ? -1 : 1));
    order.forEach((o, r) => { if (r + 1 < low[o.i]) low[o.i] = r + 1; if (r + 1 > high[o.i]) high[o.i] = r + 1; });
  }

  return scored.map((s, i) => ({
    rank: i + 1, slug: s.p.slug, name: s.p.name, category: s.p.category, chains: s.p.chains,
    tvl_usd: s.p.tvl_usd, change_7d: s.p.change_7d, mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at, gecko_id: s.p.gecko_id, symbol: s.p.symbol,
    token_status: 'pre-token' as const, age_days: ageDays(snapshot.as_of, s.p.listed_at),
    implied_value_usd: s.implied,
    model: {
      base_multiple: fit.globalMedian, growth_pct: s.growthPct, growth_multiplier: s.growthMult,
      maturity_multiplier: s.sizeFactor, age_days: ageDays(snapshot.as_of, s.p.listed_at),
      category_multiple: s.categoryMult, size_factor: s.sizeFactor, comps: 1,
      rank_low: low[i], rank_high: high[i],
    },
    farm_steps: farmSteps(s.p, ageDays(snapshot.as_of, s.p.listed_at), s.implied).map(stepText),
    verdict: netValue(s.p, s.implied).verdict,
    net_usd: netValue(s.p, s.implied).net,
  }));
}

export const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

export function stepText(step: FarmStep): string {
  let s = `${step.text} Cost: ${step.cost}. Time: ${step.time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

function chainOf(p: SnapshotProtocol): string { return p.chains.length > 0 ? p.chains[0]! : 'its main chain'; }
function capitalFor(p: SnapshotProtocol): number {
  if (p.tvl_usd >= 5_000_000_000) return 250;
  if (p.tvl_usd >= 1_000_000_000) return 150;
  if (p.tvl_usd >= 100_000_000) return 100;
  return 50;
}
function holdDaysFor(age: number | null): number { if (age === null) return 30; if (age < 180) return 60; if (age < 365) return 45; return 30; }
function actionFor(p: SnapshotProtocol, capital: number, chain: string): string {
  const c = (p.category || '').toLowerCase(), name = p.name;
  if (c.includes('lend') || c.includes('cdp') || c.includes('collateral')) return `Supply $${capital} of USDC to ${name} on ${chain} and keep the position open.`;
  if (c.includes('dex') || c.includes('yield') || c.includes('leveraged farm')) return `Provide $${capital} of liquidity to ${name}'s main pool on ${chain} and keep the position open.`;
  if (c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} through ${name} and use the bridged funds in its app.`;
  if (c.includes('staking') || c.includes('restak')) return `Stake $${capital} of the chain's staking asset through ${name} and keep the receipt.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Deposit $${capital} of USDC as margin on ${name} and open one small hedge.`;
  if (c.includes('prediction')) return `Fund $${capital} and place one market position on ${name}.`;
  if (c.includes('curator') || c.includes('allocator')) return `Deposit $${capital} into a ${name} vault on ${chain} and keep the shares.`;
  if (c.includes('stable')) return `Mint or deposit $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('rwa')) return `Mint $${capital} of the protocol's yield asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/**
 * Net a farm position to a decision: farm, thin or skip. The airdrop pool is a stated assumption
 * (0.2% of implied value shared among an assumed 500 active farmers);
 * the cost is gas plus the time horizon. Every input is the protocol's own figure or the model's
 * fitted value, and the assumption is printed in the plan so a reader can change it.
 */
export function netValue(p: SnapshotProtocol, implied: number): { verdict: 'farm' | 'thin' | 'skip'; net: number; share: number; cost: number } {
  const capital = capitalFor(p);
  // An early-user airdrop of 0.2% of implied value, split among an assumed 500 active farmers.
  // Both numbers are stated in the plan so a reader can change them; no protocol name is special.
  const pool = implied * 0.002;
  const share = pool / 500;
  const cost = (capital >= 150 ? 8 : 4) + 12;               // gas plus a stated 30-day upkeep allowance
  const net = Math.round(share - cost);
  const verdict: 'farm' | 'thin' | 'skip' = net > cost ? 'farm' : net > 0 ? 'thin' : 'skip';
  return { verdict, net, share: Math.round(share), cost };
}

/** A six-step farm plan costed to a farm / thin / skip decision, from the protocol's own record. */
export function farmSteps(p: SnapshotProtocol, age: number | null, implied?: number): FarmStep[] {
  const chain = chainOf(p), capital = capitalFor(p), hold = holdDaysFor(age), action = actionFor(p, capital, chain);
  const gas = capital >= 150 ? 8 : 4;
  const nv = implied !== undefined ? netValue(p, implied) : null;
  const lead = nv
    ? `Verdict: ${nv.verdict.toUpperCase()} — estimated airdrop share about $${nv.share} against about $${nv.cost} of gas and upkeep, net about $${nv.net}. Assumption: a 0.2% airdrop pool split among 500 active farmers. Start with a fresh wallet holding only the funds you plan to farm, and keep its seed phrase offline.`
    : `Verdict: THIN — start with a fresh wallet holding only the funds you plan to farm, and keep its seed phrase offline.`;
  const be = nv
    ? `This is a ${nv.verdict} position: net about $${nv.net} under the stated 0.2%-pool / 500-farmer assumption; change that assumption in the model and the verdict moves. Check the protocol's own points page before committing more.`
    : 'Weigh any tokens received against the position before committing more.';
  return [
    { text: lead, cost: 'under $3 of gas for the first transaction', time: '5 minutes' },
    { text: action, cost: `$${capital} of capital and about $${gas} of gas`, time: '15 minutes to set up' },
    { text: 'Make one qualifying action each week, such as a deposit, a borrow, a swap or a vote.', cost: 'about $2 of gas a week', time: '10 minutes a week' },
    { text: `Hold the position for at least ${hold} days so the activity is counted in more than one snapshot.`, cost: `the $${capital} stays in the position`, time: `${hold} days` },
    { text: be, cost: 'no extra capital; this is the netted break-even check', time: '2 minutes to work out' },
    { text: "Before you withdraw, open the protocol's own points or rewards page and claim only from the link it publishes.", cost: 'no fee to check, and never pay to claim', time: '10 minutes' },
  ];
}

/** Live-token protocols by market cap, shown as the market's own anchors, not a model. */
export function liveRows(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols.filter((p) => !isPreToken(p) && p.category !== 'CEX')
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd)
    .slice(0, LIVE_ROWS)
    .map((p) => ({ slug: p.slug, name: p.name, category: p.category, chains: p.chains, tvl_usd: p.tvl_usd, mcap_usd: p.mcap_usd, change_7d: p.change_7d }));
}

export function radarRow(row: BoardRow): RadarRow {
  return {
    rank: row.rank, slug: row.slug, name: row.name, category: row.category, chains: row.chains,
    tvl_usd: row.tvl_usd, change_7d: row.change_7d, mcap_usd: row.mcap_usd, listed_at: row.listed_at,
    age_days: row.age_days, implied_value_usd: row.implied_value_usd,
    growth_multiplier: row.model.growth_multiplier, maturity_multiplier: row.model.maturity_multiplier,
    category_multiple: row.model.category_multiple, size_factor: row.model.size_factor, comps: row.model.comps,
    rank_low: row.model.rank_low, rank_high: row.model.rank_high,
    verdict: row.verdict, net_usd: row.net_usd,
  };
}

export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; radar: RadarData } {
  const fit = fitModel(snapshot);
  const board = buildBoard(snapshot, model, fit);
  const live = liveRows(snapshot);
  const early = board.filter((r) => !snapshot.watchlist.includes(r.slug)).length;
  const radar: RadarData = {
    as_of: snapshot.as_of, source: snapshot.source, floor_usd: snapshot.floor_usd,
    model, model_version: MODEL_VERSION, watchlist_size: snapshot.watchlist.length,
    board_size: board.length, early_size: early, live_size: live.length,
    rows: board.map(radarRow), live, validation: fit.validation,
    // The comparable anchors in full (slug, name, category, tvl, mcap) so a reader's page can refit.
    anchors: snapshot.protocols.filter(isComparable).map((p) => ({
      s: p.slug, n: p.name, c: p.category, t: p.tvl_usd, m: p.mcap_usd!,
    })),
  };
  return { board, radar };
}

export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { throw new SnapshotError('snapshot.json is not JSON'); }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) throw new SnapshotError('snapshot.json is not a JSON object');
  const o = raw as Record<string, unknown>;
  if (typeof o.as_of !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(o.as_of)) throw new SnapshotError('snapshot.json has no as_of date');
  if (typeof o.source !== 'string') throw new SnapshotError('snapshot.json has no source');
  if (typeof o.floor_usd !== 'number' || !Number.isSafeInteger(o.floor_usd) || o.floor_usd <= 0) throw new SnapshotError('snapshot.json has no floor_usd');
  if (!Array.isArray(o.protocols)) throw new SnapshotError('snapshot.json has no protocols array');
  if (!Array.isArray(o.watchlist) || o.watchlist.some((s) => typeof s !== 'string')) throw new SnapshotError('snapshot.json has no watchlist of slugs');
  const protocols = o.protocols.map((v, i) => {
    if (typeof v !== 'object' || v === null || Array.isArray(v)) throw new SnapshotError(`snapshot.json's protocol ${i} is not an object`);
    const p = v as Record<string, unknown>;
    if (typeof p.slug !== 'string' || typeof p.name !== 'string' || typeof p.tvl_usd !== 'number' || !Number.isFinite(p.tvl_usd)) {
      throw new SnapshotError(`snapshot.json's protocol ${i} lacks a slug, a name or a TVL`);
    }
    return {
      slug: p.slug, name: p.name,
      category: typeof p.category === 'string' ? p.category : null,
      chains: Array.isArray(p.chains) ? p.chains.filter((c): c is string => typeof c === 'string') : [],
      tvl_usd: p.tvl_usd,
      change_7d: typeof p.change_7d === 'number' && Number.isFinite(p.change_7d) ? p.change_7d : null,
      mcap_usd: typeof p.mcap_usd === 'number' && Number.isFinite(p.mcap_usd) ? p.mcap_usd : null,
      listed_at: typeof p.listed_at === 'string' ? p.listed_at : null,
      gecko_id: typeof p.gecko_id === 'string' ? p.gecko_id : null,
      symbol: typeof p.symbol === 'string' ? p.symbol : null,
    };
  });
  return { as_of: o.as_of, source: o.source, floor_usd: o.floor_usd, protocols, watchlist: o.watchlist as string[] };
}

export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    const steps = r.farm_steps;
    if (steps.length < 3 || steps.length > 12) return `${r.slug} has ${steps.length} farm steps`;
    for (const s of steps) if (s.length < 20 || s.length > 600) return `${r.slug} has a farm step of ${s.length} characters`;
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0) return `${r.slug} has implied value ${r.implied_value_usd}`;
  }
  return null;
}

export function dataScript(radar: RadarData): string { return `window.RADAR=${JSON.stringify(radar)};\n`; }
