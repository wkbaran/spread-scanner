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
  strikeSelection: {
    /** Delta tolerance either side of the range when choosing which strikes to quote. */
    deltaSlack: number;
    /** Extra reach, in expected moves, on the at-the-money side of the strike range. */
    nearMarginEM: number;
    /** Extra reach, in expected moves, on the far side, where skew pushes the strike out. */
    farMarginEM: number;
    rate: number;
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
}

export interface Dropped {
  reason: string;
  symbols: string[];
}

export interface ScanResult {
  /** Version of this file's shape. */
  schema: 'spread-scanner/scan@1';
  generatedAt: string;
  /** New York date the scan ran on. */
  today: string;
  config: ScannerConfig;
  universe: number;
  dropped: Dropped[];
  symbols: Record<string, SymbolInfo>;
  candidates: Candidate[];
}

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
