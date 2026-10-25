export type Side = 'put' | 'call';

/** One option contract as quoted. Prices are per share; delta keeps the provider's sign. */
export interface Quote {
  side: Side;
  strike: number;
  /** YYYY-MM-DD */
  expiration: string;
  /** Calendar days from the scan date to the expiration. */
  dte: number;
  bid: number;
  ask: number;
  delta: number;
  /** The other greeks, per share (theta per day, vega per volatility point). Absent in runs saved before they were kept, null if not sent. */
  gamma?: number | null;
  theta?: number | null;
  vega?: number | null;
  rho?: number | null;
  /** Implied volatility as a fraction (0.31 is 31%). */
  iv: number;
  openInterest: number;
  volume: number;
}

export interface Spread {
  side: Side;
  expiration: string;
  dte: number;
  /** The leg sold, nearer the money. */
  short: Quote;
  /** The leg bought, further out of the money. */
  long: Quote;
  width: number;
  creditMid: number;
  /** Sell the short at its bid, buy the long at its ask. */
  creditNatural: number;
  /** Dollars per contract: (width - credit at mid) x 100. */
  maxRisk: number;
  /** Credit at mid as a share of the money at risk, in percent. */
  profitPct: number;
  breakeven: number;
  /** Chance of finishing beyond the break-even, read from the delta there, in percent. */
  popPct: number;
  /** What filling at the natural price gives up, as a share of the mid credit, in percent. */
  slippagePct: number;
}

export interface ScannerConfig {
  dte: { min: number; max: number };
  delta: { min: number; max: number };
  /** Every long leg whose strike is between `min` and `max` dollars past the short is a candidate. */
  width: { min: number; max: number };
  /** An option whose (ask - bid) / mid is over this percent is not used, short leg or long. */
  maxLegSpreadPct: number;
  earnings: { minDaysSinceLast: number; minDaysUntilNext: number };
  ranking: { weights: RankWeights };
  /**
   * The funnel used when a scan is given no symbols, so it starts from every optionable stock and fund.
   * It never applies to an explicit list of symbols.
   */
  universe: {
    /** tastytrade's liquidity rating (1 to 5) a name needs to be looked at. The cheapest stand-in for the bid-ask rule. */
    minLiquidityRating: number;
    /** After the earnings rule, only this many names, best first by IV percentile and IV over realised vol, go on to chains and quotes. */
    maxNames: number;
  };
  /**
   * The exit rules a spread is managed by, for the simulated outcome in the table: a resting order at
   * `takeProfit` (a fraction of the credit), a stop at `stopLoss` (a fraction of the most that can be lost,
   * checked on each day's close), and a time exit `exitDte` days before expiration. `fillShare` is how far from
   * the mid toward the natural price each fill lands (0 trades at the mid, 1 at the worst price), `volEdge` how
   * much the stock's path is drawn at its recent realised volatility instead of the options' implied (0 trusts
   * the options), `ivDecay` how much of each option's implied volatility has drained away by the time exit
   * (0.2 is a fifth), and `paths` and `intraday` how finely it is simulated.
   */
  outcome: OutcomeConfig;
  /** How the report shows clock times. Dates (expirations, earnings) carry no zone and are not affected. */
  display: {
    timeZone: string;
    /**
     * What the report's "Keep only" fields start at, and what "Reset" returns them to: for example
     * `{ "minIvPercentile": 30 }`. They only hide rows on the page; the scan and the saved run keep everything.
     */
    filters?: Partial<Record<DisplayFilter, number>>;
    /**
     * spread-book's report, for the "Try in spread-book" button on an opened row, which opens it with the spread
     * added as a trial trade. No URL, no button. It is embedded in the page, so it belongs in the git-ignored
     * local config, never in default.json.
     */
    spreadBookUrl?: string;
    /**
     * Show the "Paper trades" controls: with a ticket token saved in the browser, an opened row gets a "Paper trade"
     * button that queues the spread for spread-book's watcher (needs EnableTickets on the stack). Local config only.
     */
    tickets?: boolean;
  };
  strikeSelection: {
    /** Delta tolerance either side of the range when choosing which strikes to quote. */
    deltaSlack: number;
    /** Extra reach, in expected moves, on the at-the-money side of the strike range. */
    nearMarginEM: number;
    /** Extra reach, in expected moves, on the far side, where skew pushes the strike out. */
    farMarginEM: number;
    /** The risk-free rate to use when `rateFromSofr` is off, or when SOFR cannot be fetched. */
    rate: number;
    /** Use the latest SOFR from the New York Fed as the rate, and `rate` only as the fallback. */
    rateFromSofr: boolean;
  };
}

/** What a scan learned about one underlying. Several candidates share it, so it is stored once. */
export interface SymbolInfo {
  spot: number;
  isEtf: boolean;
  isIlliquid: boolean;
  sector: string | null;
  ivIndex: number | null;
  ivRank: number | null;
  ivPercentile: number | null;
  hv30: number | null;
  hv60: number | null;
  hv90: number | null;
  beta: number | null;
  liquidityRating: number | null;
  /** tastytrade's report date and its time of day (AMC or BMO), as held: next if upcoming, last if past. */
  reportDate: string | null;
  reportTimeOfDay: string | null;
  /** Where the historical volatilities came from. */
  hvSource: 'tastytrade' | 'fmp bars' | null;
  earnings: {
    ok: boolean;
    reason: string;
    last: string | null;
    next: string | null;
    daysSinceLast: number | null;
    daysUntilNext: number | null;
  };
}

export interface Candidate {
  symbol: string;
  spread: Spread;
  /** Present when both legs had an implied volatility. Absent in runs saved before it existed. */
  outcome?: Outcome;
}

export interface Dropped {
  reason: string;
  symbols: string[];
}

export interface OutcomeConfig {
  takeProfit: number;
  stopLoss: number;
  exitDte: number;
  fillShare: number;
  volEdge: number;
  ivDecay: number;
  paths: number;
  intraday: number;
}

/** A spread managed by the configured exit rules, simulated. Dollars are per contract (100 shares). */
export interface Outcome {
  /** Percent of paths that end in a profit. */
  winRate: number;
  /** Percent of paths that end at the profit target, at the stop, and at the time exit. */
  pTarget: number;
  pStop: number;
  pTime: number;
  avgWin: number;
  avgLoss: number;
  /** The average result of one spread, in dollars. */
  ev: number;
  /** The win rate at which the average win and average loss cancel: avgLoss / (avgWin + avgLoss). */
  breakEvenWinRate: number;
  /** winRate minus breakEvenWinRate, in points. Positive means the structure pays at that win rate. */
  edge: number;
}

/** One step of the funnel, for a scan that started from every optionable name. */
export interface FunnelStage {
  label: string;
  count: number;
}

export interface ScanResult {
  /** Version of this file's shape. */
  schema: 'spread-scanner/scan@1';
  generatedAt: string;
  /** New York date the scan ran on. */
  today: string;
  config: ScannerConfig;
  /** The names examined: the whole list given, or what was left after the funnel's liquidity step. */
  universe: number;
  /** The risk-free rate used to place the strike band, and where it came from. */
  rate?: { value: number; source: string };
  /** Present when the scan discovered its own names. Counts only: thousands of names are not listed. */
  funnel?: FunnelStage[];
  dropped: Dropped[];
  symbols: Record<string, SymbolInfo>;
  candidates: Candidate[];
}

/** The report's numeric "Keep only" fields: minimums and maximums on a row's figures. */
export type DisplayFilter = 'minReturn' | 'minPop' | 'maxSlippage' | 'maxLegSpread' | 'minIvPercentile' | 'minIvOverHv';
export const DISPLAY_FILTERS: readonly DisplayFilter[] = ['minReturn', 'minPop', 'maxSlippage', 'maxLegSpread', 'minIvPercentile', 'minIvOverHv'];

/** How much each component counts toward a candidate's score. Relative: only the ratios matter. */
export interface RankWeights {
  /** The underlying's IV percentile: how high IV is against its own year. */
  ivPercentile: number;
  /** IV over realised volatility: how much more the options cost than the stock has been moving. */
  ivOverHv: number;
  /** Credit at the natural price over the money at risk. */
  returnOnRisk: number;
  /** Chance of profit, from the delta at the break-even. */
  pop: number;
  /** The tighter the worse leg's bid-ask, the better. */
  legSpread: number;
  /** Distance of the short strike from the stock, in expected moves. */
  distance: number;
}

/** The raw figures behind a score. Null where the data was not available. */
export interface Components {
  /** Where IV sits in its year's range, 0 to 1. Shown beside the percentile, not scored. Absent in runs saved before it was kept. */
  ivRank?: number | null;
  ivPercentile: number | null;
  ivOverHv: number | null;
  returnOnRisk: number;
  pop: number;
  /** The wider of the two legs' (ask - bid) / mid, in percent. */
  legSpread: number;
  distance: number;
}

export type Ranks = { [K in keyof Components]: number | null };

export interface RankedCandidate extends Candidate {
  components: Components;
  /** Each component's rank among this scan's candidates (underlying-level ones among its underlyings), 0 worst to 1 best. */
  ranks: Ranks;
  /** Weighted average of the ranks that exist, 0 to 1. */
  score: number;
}

export interface RankedScan extends Omit<ScanResult, 'candidates'> {
  weights: RankWeights;
  candidates: RankedCandidate[];
}
