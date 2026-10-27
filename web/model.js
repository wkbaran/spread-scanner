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
    managedWin: [(c) => (c.outcome ? c.outcome.winRate : null), "desc"],
    needs: [(c) => (c.outcome ? c.outcome.breakEvenWinRate : null), "asc"],
    ev: [(c) => (c.outcome ? c.outcome.ev : null), "desc"],
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
  const FILTER_KEYS = ["minReturn", "minPop", "maxSlippage", "maxLegSpread", "minIvPercentile", "minIvOverHv"];

  /**
   * The filters the page opens with, and returns to on a reset: nothing hidden, except the numeric limits the
   * scan's config asks to start from (display.filters), which hold the viewer's own criteria. Ones that are not
   * numbers, or are not filters the page has, are ignored, so an old or odd config cannot break the page.
   */
  function defaultFilters(config) {
    const f = emptyFilters();
    const wanted = (config && config.display && config.display.filters) || {};
    for (const key of FILTER_KEYS) if (typeof wanted[key] === "number" && Number.isFinite(wanted[key])) f[key] = wanted[key];
    return f;
  }

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
   * moves below the stock, 1 is 1.5 above). The expected move is one standard deviation: the short
   * option's own IV over the days left. That is the volatility its delta was computed with, so a strike at
   * 0.16 delta sits at the edge of the band. The IV index (an at-the-money figure, often far from the
   * wing's) is used only when the option has no IV of its own.
   */
  const GREEKS = ["delta", "gamma", "theta", "vega", "rho"];

  /**
   * What the spread holds, per share: the leg bought minus the leg sold, greek by greek. A bull put spread comes
   * out with a little positive delta and a bear call spread with a little negative, and theta is usually positive
   * because the sold leg decays faster. Null when either leg lacks any of them (runs saved before they were kept).
   */
  function netGreeks(spread) {
    const out = {};
    for (const g of GREEKS) {
      const bought = spread.long[g];
      const sold = spread.short[g];
      if (bought === null || bought === undefined || sold === null || sold === undefined) return null;
      out[g] = bought - sold;
    }
    return out;
  }

  function ruler(candidate, info) {
    const s = candidate.spread;
    const iv = s.short.iv > 0 ? s.short.iv : info.ivIndex;
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

  /**
   * The link that opens this spread in OptionStrat's builder: the strategy, the underlying, then the leg bought
   * and the leg sold (leading minus), each as a dot, the root, YYMMDD, P or C and the strike. Verified against
   * the site for a put and a call spread and for a half-dollar strike. Which view it opens in (table or graph)
   * is not in the link: OptionStrat keeps that choice in the visitor's own browser. Null for a symbol that is
   * not a plain letters-only root (BRK/B and the like), where the option root can differ from the stock's.
   */
  function optionStratUrl(candidate) {
    const s = candidate.spread;
    if (!/^[A-Z]{1,6}$/.test(candidate.symbol)) return null;
    const [yyyy, mm, dd] = s.expiration.split("-");
    const leg = (q) => `.${candidate.symbol}${yyyy.slice(2)}${mm}${dd}${s.side === "put" ? "P" : "C"}${q.strike}`;
    const strategy = s.side === "put" ? "bull-put-spread" : "bear-call-spread";
    return `https://optionstrat.com/build/${strategy}/${candidate.symbol}/${leg(s.long)},-${leg(s.short)}`;
  }

  /**
   * The ticker's TradingView chart. No exchange prefix: the scan does not carry one, so TradingView picks the
   * listing, which for a few tickers is a foreign one. A class share's slash becomes TradingView's dot (BRK/B is
   * BRK.B). Null for anything that does not look like a ticker.
   */
  function tradingViewSymbol(symbol) {
    return /^[A-Z][A-Z0-9]*([./][A-Z0-9]+)?$/.test(symbol) ? symbol.replace("/", ".") : null;
  }
  function tradingViewUrl(symbol) {
    const tv = tradingViewSymbol(symbol);
    return tv === null ? null : `https://www.tradingview.com/chart/?symbol=${encodeURIComponent(tv)}`;
  }

  /**
   * The chart panel's src: TradingView's advanced-chart widget, its settings as JSON in the hash, as equity-watch
   * builds it (see chartEmbedUrl there for how the keys were found). The theme goes under both `theme` and
   * `colorTheme` because the endpoint has honoured each at different times; keep both. The Moving Average Ribbon
   * draws the 20, 50, 100 and 200 day averages with no overrides, which this endpoint handles badly.
   */
  function tradingViewEmbedUrl(symbol, theme) {
    const settings = {
      symbol: tradingViewSymbol(symbol) ?? "",
      interval: "D",
      timezone: "America/New_York",
      theme,
      colorTheme: theme,
      style: "1",
      autosize: true,
      hide_side_toolbar: true,
      allow_symbol_change: true,
      studies: ["STD;MA%Ribbon"],
    };
    return `https://s.tradingview.com/embed-widget/advanced-chart/#${encodeURIComponent(JSON.stringify(settings))}`;
  }

  /**
   * The link that opens spread-book's report with this spread added as a trial trade ("Try in spread-book"):
   * `base` with `#try=` and the trade as base64url JSON, `{ v: 1, trades: [trade] }`. spread-book's `readTry`
   * and `tryTrade` (book.js there) read it and convert the units, so the trade goes in this page's own: credit
   * per share at the mid, popPct in percent, each leg's greeks per share and its IV as a fraction (null where a
   * leg has none). In the fragment so it never reaches the server or its logs. One contract. Null without a base
   * (display.spreadBookUrl not configured), and any fragment the base already has is replaced.
   */
  function spreadBookUrl(base, candidate) {
    if (!base) return null;
    const s = candidate.spread;
    const leg = (q) => ({ strike: q.strike, delta: q.delta, gamma: q.gamma ?? null, theta: q.theta ?? null, vega: q.vega ?? null, iv: q.iv || null });
    const trade = { symbol: candidate.symbol, side: s.side, expiration: s.expiration, qty: 1, credit: s.creditMid, popPct: s.popPct, short: leg(s.short), long: leg(s.long) };
    const b64 = btoa(JSON.stringify({ v: 1, trades: [trade] })).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
    return `${String(base).split("#")[0]}#try=${b64}`;
  }

  /**
   * The ticket the "Paper trade" button sends (POST /api/tickets): spread-book's watcher opens this spread as a paper
   * trade, one contract, priced from live quotes when it acts, not at these. `seen` is what this page showed, kept
   * with the trade for comparison. The ticket Lambda (infra/cloudformation.yaml) checks the shape; keep the two in
   * step. `id` is the ticket's own, made fresh for each click: SQS drops a repeat of the same id.
   */
  function paperTicket(candidate, id) {
    const s = candidate.spread;
    return {
      id,
      type: "paper.open",
      trade: { symbol: candidate.symbol, side: s.side, expiration: s.expiration, shortStrike: s.short.strike, longStrike: s.long.strike, qty: 1 },
      seen: { creditMid: s.creditMid, creditNatural: s.creditNatural, popPct: s.popPct },
    };
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
    defaultFilters,
    FILTER_KEYS,
    filterCandidates,
    capPerUnderlying,
    visible,
    distinctWidths,
    distinctExpirations,
    ruler,
    shortDate,
    optionStratUrl,
    tradingViewUrl,
    tradingViewEmbedUrl,
    spreadBookUrl,
    paperTicket,
    GREEKS,
    netGreeks,
  };
})();
