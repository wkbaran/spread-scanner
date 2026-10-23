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
