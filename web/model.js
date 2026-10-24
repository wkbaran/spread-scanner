// The report's logic, with no DOM in it: filtering, re-scoring with the user's weights, sorting
// and the geometry of the strike ruler. A classic script (no modules) so the page also opens from
// a file:// URL; test/web.test.ts evaluates this file in Node and checks it against src/rank.ts.
(() => {
  "use strict";

  const WEIGHT_KEYS = ["ivPercentile", "ivOverHv", "returnOnRisk", "pop", "legSpread", "distance"];

  /** How many expected moves each side of the stock the ruler covers. */
  const RULER_EM = 1.5;

  /**
   * The same weighted average as weightedScore in src/rank.ts, which tests pin this copy to: a
   * component with no rank, or no weight, drops out, and nothing to score on gives 0.5.
   */
  function weightedScore(ranks, weights) {
    let sum = 0;
    let total = 0;
    for (const key of WEIGHT_KEYS) {
      const rank = ranks[key];
      const weight = weights[key];
      if (rank === null || rank === undefined || !weight) continue;
      sum += weight * rank;
      total += weight;
    }
    return total === 0 ? 0.5 : sum / total;
  }

  /** Candidates with `score` recomputed from `weights`. The saved score is left alone on the input. */
  function rescore(candidates, weights) {
    return candidates.map((c) => ({ ...c, score: weightedScore(c.ranks, weights) }));
  }

  const worstLegSpread = (c) => c.components.legSpread;

  /** Keys the table can sort by, each as [value, direction that reads as "best first"]. */
  const SORTS = {
    score: [(c) => c.score, "desc"],
    symbol: [(c) => c.symbol, "asc"],
    expiration: [(c) => c.spread.expiration, "asc"],
    width: [(c) => c.spread.width, "asc"],
    credit: [(c) => c.spread.creditMid, "desc"],
    maxRisk: [(c) => c.spread.maxRisk, "asc"],
    returnOnRisk: [(c) => c.spread.profitPct, "desc"],
    pop: [(c) => c.spread.popPct, "desc"],
    slippage: [(c) => c.spread.slippagePct, "asc"],
    legSpread: [(c) => worstLegSpread(c), "asc"],
    ivRank: [(c) => c.components.ivRank, "desc"],
    ivPercentile: [(c) => c.components.ivPercentile, "desc"],
    ivOverHv: [(c) => c.components.ivOverHv, "desc"],
    distance: [(c) => c.components.distance, "desc"],
  };

  function defaultDirection(key) {
    return SORTS[key] ? SORTS[key][1] : "desc";
  }

  /** Sorted copy. Missing values go last whichever way it sorts; ties break on symbol then short strike. */
  function sortCandidates(candidates, key, direction) {
    const [value] = SORTS[key] || SORTS.score;
    const sign = direction === "asc" ? 1 : -1;
    return [...candidates].sort((a, b) => {
      const x = value(a);
      const y = value(b);
      const xNone = x === null || x === undefined;
      const yNone = y === null || y === undefined;
      if (xNone !== yNone) return xNone ? 1 : -1;
      if (!xNone && x !== y) return (typeof x === "string" ? x.localeCompare(y) : x - y) * sign;
      return a.symbol.localeCompare(b.symbol) || a.spread.short.strike - b.spread.short.strike || a.spread.width - b.spread.width;
    });
  }

  const emptyFilters = () => ({
    put: true,
    call: true,
    widths: null, // null: every width; otherwise an array of the widths wanted
    expiration: "all",
    kind: "all", // all | stocks | funds
    minReturn: null,
    minPop: null,
    maxSlippage: null,
    maxLegSpread: null,
    minIvPercentile: null,
    minIvOverHv: null,
    search: "",
    perUnderlying: 3, // 0 keeps them all
  });

  const present = (v) => v !== null && v !== undefined && v !== "" && !Number.isNaN(v);

  /** The candidates that pass every filter that is set. A missing figure fails a filter that asks for it. */
  function filterCandidates(candidates, symbols, f) {
    const search = f.search.trim().toUpperCase();
    const widths = f.widths === null ? null : new Set(f.widths);
    return candidates.filter((c) => {
      const s = c.spread;
      const info = symbols[c.symbol];
      if (!f[s.side]) return false;
      if (widths !== null && !widths.has(s.width)) return false;
      if (f.expiration !== "all" && s.expiration !== f.expiration) return false;
      if (f.kind === "stocks" && info.isEtf) return false;
      if (f.kind === "funds" && !info.isEtf) return false;
      if (search !== "" && !c.symbol.includes(search)) return false;
      if (present(f.minReturn) && !(s.profitPct >= f.minReturn)) return false;
      if (present(f.minPop) && !(s.popPct >= f.minPop)) return false;
      if (present(f.maxSlippage) && !(s.slippagePct <= f.maxSlippage)) return false;
      if (present(f.maxLegSpread) && !(worstLegSpread(c) <= f.maxLegSpread)) return false;
      if (present(f.minIvPercentile) && !(c.components.ivPercentile !== null && c.components.ivPercentile * 100 >= f.minIvPercentile)) return false;
      if (present(f.minIvOverHv) && !(c.components.ivOverHv !== null && c.components.ivOverHv >= f.minIvOverHv)) return false;
      return true;
    });
  }

  /** Keeps the first `n` of each underlying, in the order given. 0 keeps everything. */
  function capPerUnderlying(candidates, n) {
    if (!n) return candidates;
    const seen = new Map();
    return candidates.filter((c) => {
      const k = (seen.get(c.symbol) || 0) + 1;
      seen.set(c.symbol, k);
      return k <= n;
    });
  }

  /** The list on screen: filter, re-score, sort, then cap each underlying (so the cap keeps its best by the sort). */
  function visible(scan, weights, filters, sortKey, direction) {
    const filtered = filterCandidates(scan.candidates, scan.symbols, filters);
    const sorted = sortCandidates(rescore(filtered, weights), sortKey, direction);
    return capPerUnderlying(sorted, filters.perUnderlying);
  }

  function distinctWidths(candidates) {
    return [...new Set(candidates.map((c) => c.spread.width))].sort((a, b) => a - b);
  }

  function distinctExpirations(candidates) {
    const byDate = new Map();
    for (const c of candidates) byDate.set(c.spread.expiration, c.spread.dte);
    return [...byDate].sort((a, b) => a[0].localeCompare(b[0])).map(([date, dte]) => ({ date, dte }));
  }

  /**
   * Where the pieces of a spread fall on the ruler, as fractions of its width (0 is 1.5 expected
   * moves below the stock, 1 is 1.5 above). The expected move is the stock's IV over the days left,
   * so a long-dated, high-IV name gets a wide band and its strikes sit nearer the middle.
   */
  function ruler(candidate, info) {
    const s = candidate.spread;
    const iv = info.ivIndex;
    const em = iv ? info.spot * iv * Math.sqrt(s.dte / 365) : null;
    if (!em) return null;
    const at = (price) => Math.min(1, Math.max(0, 0.5 + (price - info.spot) / em / (2 * RULER_EM)));
    const clipped = (price) => Math.abs(price - info.spot) / em > RULER_EM;
    return {
      band: [at(info.spot - em), at(info.spot + em)],
      short: at(s.short.strike),
      long: at(s.long.strike),
      breakeven: at(s.breakeven),
      clipped: clipped(s.short.strike) || clipped(s.long.strike),
      distance: Math.abs(info.spot - s.short.strike) / em,
    };
  }

  const MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];

  /** "Nov 30" from 2026-11-30. */
  function shortDate(iso) {
    const [, m, d] = iso.split("-");
    return `${MONTHS[Number(m) - 1]} ${Number(d)}`;
  }

  const trim = (n) => String(Math.round(n * 1000) / 1000);

  /** The spread as a person would say it to a broker: "SPY Nov 30 713/708 put spread, credit 0.40". */
  function describe(candidate) {
    const s = candidate.spread;
    return `${candidate.symbol} ${shortDate(s.expiration)} ${trim(s.short.strike)}/${trim(s.long.strike)} ${s.side} spread, credit ${s.creditMid.toFixed(2)}`;
  }

  globalThis.SpreadModel = {
    WEIGHT_KEYS,
    RULER_EM,
    SORTS,
    defaultDirection,
    weightedScore,
    rescore,
    sortCandidates,
    emptyFilters,
    filterCandidates,
    capPerUnderlying,
    visible,
    distinctWidths,
    distinctExpirations,
    ruler,
    shortDate,
    describe,
  };
})();
