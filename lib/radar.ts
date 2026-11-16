// Token Radar's value model: a sealed snapshot in, a ranked board out.
//
// The board ranks every protocol in the snapshot that records no token and is
// not a wrapped, staked or bridged product of a token that already trades --
// the watchlist's own exclusion rule, without its TVL floor. A protocol is
// pre-token when DefiLlama records no market cap, no CoinGecko id and no
// symbol for it. Protocols whose token already trades are kept apart in a
// live set and shown with the market's own values, never mixed into the board.
//
// Implied value is what the protocol would be worth if it traded like the
// live-token protocols in its own category, today:
//
//   implied = round(tvl_usd x multiple x growth x maturity x breadth)
//
//   multiple  the category's live-market multiple: the median market-cap /
//             TVL of the snapshot's live-token protocols in the same
//             category. A category counts only with at least 3 live comps;
//             with fewer, the global median is used. The category median is
//             shrunk toward the global median (prior weight 4) so one odd
//             comp cannot set a sector, and capped at 1.5x. No name is ever
//             special-cased: the same rule scores every protocol.
//   growth    1 + clamp(change_7d, -50, 150) / 100 x 0.5. A protocol whose
//             TVL is growing fast is worth more than one the same size whose
//             TVL is shrinking; an unreported change counts as zero.
//   maturity  0.7 + min(age_days, 1460) / 1460 x 0.5. Age is the days since
//             DefiLlama first listed the protocol: the best record of how
//             long it has run with no token. A protocol with no listing date
//             takes the median age of the ranked set.
//   breadth   1 + min(chains - 1, 4) x 0.03. A protocol live on more chains
//             has more surface for a launch to land on.
//
// Every factor is rounded to four decimals before it is multiplied, so the
// dashboard can recompute a row from the factors the board carries and get
// the same number. The model is a pure function of the snapshot: no clock,
// no randomness, no network, and every tie breaks on the slug.

export interface SnapProtocol {
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

export interface Snapshot {
  as_of: string;
  source: string;
  floor_usd: number;
  protocols: SnapProtocol[];
  watchlist: string[];
}

/** The model's constants, printed on the dashboard so the page states them. */
export interface ModelConstants {
  growth_weight: number;
  growth_floor: number;
  growth_cap: number;
  maturity_floor: number;
  maturity_span: number;
  maturity_days: number;
  breadth_step: number;
  breadth_max_extra: number;
  comp_min_n: number;
  comp_prior: number;
  comp_cap: number;
}

export const MODEL: ModelConstants = {
  growth_weight: 0.5,
  growth_floor: -50,
  growth_cap: 150,
  maturity_floor: 0.7,
  maturity_span: 0.5,
  maturity_days: 1460,
  breadth_step: 0.03,
  breadth_max_extra: 4,
  comp_min_n: 3,
  comp_prior: 4,
  comp_cap: 1.5,
};

export const MODEL_VERSION = 'radar-2';

/** How many live-token protocols the dashboard's Live view carries, by market cap. */
export const LIVE_ROWS = 24;

const DAY_MS = 86_400_000;

/** The four factors behind one row's implied value, as the board stores them. */
export interface ValueFactors {
  multiple: number;
  comp_n: number;
  growth_pct: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
  age_days: number | null;
}

/** One row of board.json. */
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
  age_days: number | null;
  token_status: 'pre-token';
  implied_value_usd: number;
  factors: ValueFactors;
  farm_steps: string[];
}

/** A live-token protocol, shown with the market's own value, never modelled. */
export interface LiveRow {
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  mcap_usd: number;
  change_7d: number | null;
}

/** One row of the dashboard's live-market multiple table. */
export interface CompRow {
  category: string;
  n: number;
  median: number | null;
  multiple: number;
}

/** Everything the dashboard renders, written to data.js beside the page. */
export interface RadarPayload {
  as_of: string;
  source: string;
  floor_usd: number;
  model: ModelConstants;
  model_version: string;
  watchlist_size: number;
  board_size: number;
  live_size: number;
  total_implied_usd: number;
  comps: CompRow[];
  rows: RadarRow[];
  live: LiveRow[];
}

/** A board row's compact form for the page, carrying its factors and farm plan. */
export interface RadarRow {
  rank: number;
  slug: string;
  name: string;
  category: string | null;
  chains: string[];
  tvl_usd: number;
  change_7d: number | null;
  age_days: number | null;
  implied_value_usd: number;
  multiple: number;
  comp_n: number;
  growth_multiplier: number;
  maturity_multiplier: number;
  breadth_multiplier: number;
  watchlist: boolean;
  farm_steps: string[];
}

export class SnapshotError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SnapshotError';
  }
}

const round4 = (n: number): number => Math.round(n * 1e4) / 1e4;

/** The middle of a sorted list, or the mean of the two middles. */
function median(sorted: number[]): number {
  const n = sorted.length;
  if (n === 0) return NaN;
  const mid = Math.floor(n / 2);
  return n % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
}

/** A finite number, else `fallback`. */
function finite(value: unknown, fallback: number): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

/** Whole days from `listedAt` to `asOf`, clamped at zero; null when either is absent or bad. */
export function ageDays(asOf: string, listedAt: string | null): number | null {
  if (listedAt === null) return null;
  const a = Date.parse(`${asOf}T00:00:00Z`);
  const b = Date.parse(`${listedAt}T00:00:00Z`);
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.max(0, Math.floor((a - b) / DAY_MS));
}

/** Whether the snapshot records no token at all for a protocol. */
export function isPreToken(p: SnapProtocol): boolean {
  return p.mcap_usd === null && p.gecko_id === null && p.symbol === null;
}

const VERSIONED_NAME = /\s(V\d+(\.\d+)?|v\d+(\.\d+)?|\d+\.\d+)$/;
const WRAPPED_WORD = /\b(wrapped|staked|staking)\b/i;
const EXCLUDED_CATEGORY = new Set(['Bridge', 'Canonical Bridge', 'Liquid Staking', 'Liquid Restaking', 'Restaked BTC', 'CEX']);
const EXCHANGE_PREFIX = new Set(['Binance', 'Coinbase', 'Bybit', 'Kraken', 'Bitget', 'OKX', 'Bitfinex', 'Gemini']);

/**
 * Whether a protocol belongs on the board: pre-token, and not a wrapped,
 * staked or bridged product of a token that already trades. This is the
 * watchlist's own exclusion rule, applied without its TVL floor, so the
 * board can reach the early protocols below it.
 */
export function isRankable(p: SnapProtocol): boolean {
  if (!isPreToken(p)) return false;
  if (p.category !== null && EXCLUDED_CATEGORY.has(p.category)) return false;
  if (VERSIONED_NAME.test(p.name)) return false;
  if (WRAPPED_WORD.test(p.name)) return false;
  const firstWord = p.name.split(/\s+/)[0];
  if (firstWord !== undefined && EXCHANGE_PREFIX.has(firstWord)) return false;
  return true;
}

/** The live-market multiples, computed from the snapshot's live-token protocols. */
export interface CompTable {
  global: number;
  byCategory: Map<string, { n: number; median: number | null; multiple: number }>;
  rows: CompRow[];
}

export function buildComps(snapshot: Snapshot, model: ModelConstants = MODEL): CompTable {
  const live = snapshot.protocols.filter(
    (p) => !isPreToken(p) && p.mcap_usd !== null && p.mcap_usd > 0 && p.tvl_usd > 0,
  );
  const ratios = live.map((p) => p.mcap_usd! / p.tvl_usd).sort((a, b) => a - b);
  const global = round4(median(ratios));
  const byCategory = new Map<string, { n: number; median: number | null; multiple: number }>();
  const perCategory = new Map<string, number[]>();
  for (const p of live) {
    const key = p.category ?? 'Other';
    const list = perCategory.get(key);
    if (list === undefined) perCategory.set(key, [p.mcap_usd! / p.tvl_usd]);
    else list.push(p.mcap_usd! / p.tvl_usd);
  }
  for (const [category, values] of [...perCategory.entries()].sort((a, b) => (a[0] < b[0] ? -1 : 1))) {
    const sorted = values.sort((a, b) => a - b);
    const med = median(sorted);
    let multiple: number;
    if (sorted.length >= model.comp_min_n) {
      const shrunk = (sorted.length * med + model.comp_prior * global) / (sorted.length + model.comp_prior);
      multiple = round4(Math.min(shrunk, model.comp_cap));
    } else {
      multiple = global;
    }
    byCategory.set(category, { n: sorted.length, median: round4(med), multiple });
  }
  const rows: CompRow[] = [...byCategory.entries()]
    .map(([category, v]) => ({ category, n: v.n, median: v.median, multiple: v.multiple }))
    .sort((a, b) => b.n - a.n || (a.category < b.category ? -1 : 1));
  return { global, byCategory, rows };
}

/** A protocol's multiple: its category's, or the global median when the category has too few comps. */
function multipleFor(p: SnapProtocol, comps: CompTable): { multiple: number; compN: number } {
  const entry = comps.byCategory.get(p.category ?? 'Other');
  if (entry === undefined) return { multiple: comps.global, compN: 0 };
  return { multiple: entry.multiple, compN: entry.n };
}

/** The four factors and the implied value one protocol gets under the model. */
export function scoreProtocol(
  p: SnapProtocol,
  asOf: string,
  comps: CompTable,
  medianAge: number,
  model: ModelConstants = MODEL,
): { implied: number; factors: ValueFactors } {
  const { multiple, compN } = multipleFor(p, comps);
  const growthPct = Math.min(model.growth_cap, Math.max(model.growth_floor, finite(p.change_7d, 0)));
  const growthMult = round4(1 + (growthPct / 100) * model.growth_weight);
  const age = ageDays(asOf, p.listed_at);
  const ageForModel = age ?? medianAge;
  const maturityMult = round4(
    model.maturity_floor + (Math.min(Math.max(ageForModel, 0), model.maturity_days) / model.maturity_days) * model.maturity_span,
  );
  const extraChains = Math.min(Math.max(p.chains.length - 1, 0), model.breadth_max_extra);
  const breadthMult = round4(1 + extraChains * model.breadth_step);
  const implied = Math.max(1, Math.min(100_000_000_000_000, Math.round(p.tvl_usd * multiple * growthMult * maturityMult * breadthMult)));
  return {
    implied,
    factors: {
      multiple,
      comp_n: compN,
      growth_pct: growthPct,
      growth_multiplier: growthMult,
      maturity_multiplier: maturityMult,
      breadth_multiplier: breadthMult,
      age_days: age,
    },
  };
}

/** How much capital one farm position needs, from the protocol's own TVL. */
function capitalFor(p: SnapProtocol): number {
  if (p.tvl_usd >= 1_000_000_000) return 200;
  if (p.tvl_usd >= 250_000_000) return 150;
  if (p.tvl_usd >= 50_000_000) return 100;
  return 50;
}

/** How long to hold, from the protocol's age: younger protocols get a longer qualifying window. */
function holdDaysFor(age: number | null): number {
  if (age === null) return 45;
  if (age < 180) return 60;
  if (age < 365) return 45;
  return 30;
}

/** The first chain a protocol names, or a neutral phrase. */
function firstChain(p: SnapProtocol): string {
  return p.chains.length > 0 ? p.chains[0]! : 'its main chain';
}

/** The core farming action, from the protocol's category: one verb per kind of protocol. */
function coreAction(p: SnapProtocol, capital: number, chain: string): string {
  const c = (p.category ?? '').toLowerCase();
  const name = p.name;
  if (c.includes('cdp') || c.includes('collateral')) return `Lend $${capital} of USDC into ${name}'s ${chain} market and leave the deposit earning.`;
  if (c.includes('cross chain') || c.includes('bridge')) return `Bridge $${capital} of USDC to ${chain} with ${name}, then put the bridged funds to work in its app.`;
  if (c.includes('dex')) return `Add $${capital} of liquidity to ${name}'s busiest ${chain} pool and keep the LP position open.`;
  if (c.includes('yield aggregator') || c.includes('yield') || c.includes('leveraged farm') || c.includes('farm')) return `Deposit $${capital} of USDC into ${name}'s highest-yield ${chain} vault and keep the shares.`;
  if (c.includes('perpetual') || c.includes('derivative')) return `Post $${capital} of USDC as margin on ${name} and open one small hedged position.`;
  if (c.includes('prediction')) return `Fund $${capital} and take one position in ${name}'s most active market.`;
  if (c.includes('curator') || c.includes('capital allocator') || c.includes('allocator')) return `Allocate $${capital} into a ${name} curator vault on ${chain} and hold the shares.`;
  if (c.includes('rwa')) return `Mint $${capital} of ${name}'s yield-bearing asset on ${chain} and hold it.`;
  if (c.includes('insurance')) return `Buy $${capital} of cover from ${name} on ${chain} and keep the policy active.`;
  if (c.includes('stable')) return `Mint or hold $${capital} of the stable asset through ${name} on ${chain}.`;
  if (c.includes('lend')) return `Lend $${capital} of USDC into ${name}'s ${chain} market and leave the deposit earning.`;
  if (c.includes('chain')) return `Stake $${capital} through ${name}'s ${chain} app and keep the receipt.`;
  return `Deposit $${capital} of USDC into ${name} on ${chain} and keep the position open.`;
}

/** One farm step as a single string: the action, then what it costs and how long it takes. */
function stepText(text: string, cost: string, time: string): string {
  let s = `${text} Cost: ${cost}. Time: ${time}.`;
  if (s.length > 600) s = `${s.slice(0, 596)}...`;
  if (s.length < 20) s = `${s} Hold the position and check the protocol's own page.`;
  return s;
}

/**
 * A protocol's farm plan: seven steps, each derived from the protocol's own
 * record (category, chains, TVL, age). No name is special-cased.
 */
export function farmPlan(p: SnapProtocol, age: number | null): string[] {
  const chain = firstChain(p);
  const capital = capitalFor(p);
  const hold = holdDaysFor(age);
  const secondChain = p.chains.length > 1 ? p.chains[1]! : null;
  const secondAction =
    secondChain !== null
      ? `Put about $${Math.ceil(capital / 2)} of the position on ${secondChain} as well, so the wallet's activity shows on two chains instead of one.`
      : `Use a second feature of ${p.name} — a swap, a borrow or a vote — so the wallet's history is more than one deposit.`;
  return [
    stepText(
      'Start with a fresh wallet that holds only the funds you mean to farm, and keep its seed phrase offline.',
      'under $3 of gas for the first transaction',
      '5 minutes',
    ),
    stepText(coreAction(p, capital, chain), `$${capital} of capital and about $${capital >= 150 ? 8 : 4} of gas`, '15 minutes to set up'),
    stepText(secondAction, `about $${Math.ceil(capital / 2)} of capital and about $4 of gas`, '15 minutes'),
    stepText(
      'Do one qualifying action every week — a deposit, a borrow, a swap or a vote — and keep the position open between them.',
      'about $2 of gas a week',
      '10 minutes a week',
    ),
    stepText(
      `Hold the position for at least ${hold} days, so the activity lands in more than one snapshot window.`,
      `the $${capital} stays in the position`,
      `${hold} days`,
    ),
    stepText(
      "Open the protocol's own points or rewards page and claim only from the link it publishes; never pay anyone to claim for you.",
      'free to check, and never pay to claim',
      '10 minutes',
    ),
    stepText(
      'Write the wallet, the dates and every transaction hash in a farm log, so you can repeat the position or unwind it cleanly.',
      'nothing but the log',
      '5 minutes',
    ),
  ];
}

/** The live-token protocols, by market cap, for the dashboard's Live view. */
export function liveSet(snapshot: Snapshot): LiveRow[] {
  return snapshot.protocols
    .filter((p) => !isPreToken(p) && p.category !== 'CEX' && p.mcap_usd !== null)
    .sort((a, b) => (b.mcap_usd ?? 0) - (a.mcap_usd ?? 0) || b.tvl_usd - a.tvl_usd || (a.slug < b.slug ? -1 : 1))
    .slice(0, LIVE_ROWS)
    .map((p) => ({
      slug: p.slug,
      name: p.name,
      category: p.category,
      chains: p.chains,
      tvl_usd: p.tvl_usd,
      mcap_usd: p.mcap_usd!,
      change_7d: p.change_7d,
    }));
}

/** The ranked board: every rankable protocol, strongest implied value first, ranks 1..n. */
export function buildBoard(snapshot: Snapshot, model: ModelConstants = MODEL): BoardRow[] {
  const comps = buildComps(snapshot, model);
  const rankable = snapshot.protocols.filter(isRankable);
  const knownAges = rankable
    .map((p) => ageDays(snapshot.as_of, p.listed_at))
    .filter((a): a is number => a !== null)
    .sort((a, b) => a - b);
  const medianAge = knownAges.length > 0 ? median(knownAges) : 365;
  const scored = rankable.map((p) => {
    const { implied, factors } = scoreProtocol(p, snapshot.as_of, comps, medianAge, model);
    return { p, implied, factors };
  });
  scored.sort((a, b) => b.implied - a.implied || (a.p.slug < b.p.slug ? -1 : a.p.slug > b.p.slug ? 1 : 0));
  return scored.map((s, i) => ({
    rank: i + 1,
    slug: s.p.slug,
    name: s.p.name,
    category: s.p.category,
    chains: s.p.chains,
    tvl_usd: s.p.tvl_usd,
    change_7d: s.p.change_7d,
    mcap_usd: s.p.mcap_usd,
    listed_at: s.p.listed_at,
    age_days: s.factors.age_days,
    token_status: 'pre-token' as const,
    implied_value_usd: s.implied,
    factors: s.factors,
    farm_steps: farmPlan(s.p, s.factors.age_days),
  }));
}

/** Everything the dashboard renders, from the snapshot. */
export function buildRadar(snapshot: Snapshot, model: ModelConstants = MODEL): { board: BoardRow[]; payload: RadarPayload } {
  const board = buildBoard(snapshot, model);
  const comps = buildComps(snapshot, model);
  const live = liveSet(snapshot);
  const rows: RadarRow[] = board.map((r) => ({
    rank: r.rank,
    slug: r.slug,
    name: r.name,
    category: r.category,
    chains: r.chains,
    tvl_usd: r.tvl_usd,
    change_7d: r.change_7d,
    age_days: r.age_days,
    implied_value_usd: r.implied_value_usd,
    multiple: r.factors.multiple,
    comp_n: r.factors.comp_n,
    growth_multiplier: r.factors.growth_multiplier,
    maturity_multiplier: r.factors.maturity_multiplier,
    breadth_multiplier: r.factors.breadth_multiplier,
    watchlist: snapshot.watchlist.includes(r.slug),
    farm_steps: r.farm_steps,
  }));
  const payload: RadarPayload = {
    as_of: snapshot.as_of,
    source: snapshot.source,
    floor_usd: snapshot.floor_usd,
    model,
    model_version: MODEL_VERSION,
    watchlist_size: snapshot.watchlist.length,
    board_size: board.length,
    live_size: live.length,
    total_implied_usd: board.reduce((n, r) => n + r.implied_value_usd, 0),
    comps: comps.rows,
    rows,
    live,
  };
  return { board, payload };
}

/** The snapshot out of a file's text, refused unless it is the shape the model scores. */
export function parseSnapshot(text: string): Snapshot {
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new SnapshotError('snapshot.json is not JSON');
  }
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
      slug: p.slug,
      name: p.name,
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
  return {
    as_of: o.as_of,
    source: o.source,
    floor_usd: o.floor_usd,
    protocols,
    watchlist: o.watchlist as string[],
  };
}

/** Why a board is not one the gate will take, or null: coverage, ranks, order, one shared value, farm steps. */
export function boardIssue(board: BoardRow[], snapshot: Snapshot): string | null {
  if (board.length < 100 || board.length > 4000) return `the board holds ${board.length} rows, outside 100..4000`;
  const slugs = new Set(board.map((r) => r.slug));
  const missing = snapshot.watchlist.filter((s) => !slugs.has(s));
  if (missing.length > 0) return `the board misses ${missing.length} watchlist slug${missing.length === 1 ? '' : 's'}: ${missing.slice(0, 5).join(', ')}`;
  const bySlug = new Map(snapshot.protocols.map((p) => [p.slug, p]));
  for (const r of board) if (!bySlug.has(r.slug)) return `row ${r.slug} names a protocol the snapshot does not carry`;
  const ranks = board.map((r) => r.rank).sort((a, b) => a - b);
  for (let i = 0; i < ranks.length; i++) if (ranks[i] !== i + 1) return `rank ${i + 1} is ${ranks[i]}`;
  for (let i = 1; i < board.length; i++) if (board[i]!.implied_value_usd > board[i - 1]!.implied_value_usd) return `row ${i + 1} outranks row ${i} on implied value`;
  if (board.length >= 2 && board[0]!.implied_value_usd === board[board.length - 1]!.implied_value_usd) {
    return `all ${board.length} rows share the same implied value $${board[0]!.implied_value_usd}: a board that ranks nothing by value is not a ranking`;
  }
  for (const r of board) {
    if (!Number.isSafeInteger(r.implied_value_usd) || r.implied_value_usd <= 0 || r.implied_value_usd > 100_000_000_000_000) {
      return `${r.slug} has implied value ${r.implied_value_usd}`;
    }
    if (r.farm_steps.length < 3 || r.farm_steps.length > 12) return `${r.slug} has ${r.farm_steps.length} farm steps`;
    for (const s of r.farm_steps) {
      const t = s.trim();
      if (t.length < 20 || t.length > 600) return `${r.slug} has a farm step of ${t.length} characters`;
    }
  }
  return null;
}

/** The dashboard's dataset as one script: no fetch, no network, the page reads window.RADAR. */
export function dataScript(payload: RadarPayload): string {
  return `window.RADAR=${JSON.stringify(payload)};\n`;
}
