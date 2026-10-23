# spread-scanner

Ranks credit-spread candidates (bull put and bear call) from live option data: which spreads are worth opening, and how likely the options are to be overpriced.

**Status: early.** The selection and scoring logic is written and tested. The data providers (tastytrade, FMP), the ranking and the command line are not. See [What is not here yet](#what-is-not-here-yet).

It needs no Schwab account. Option quotes, greeks, open interest, IV rank and earnings dates come from tastytrade's API; daily price history and a second source of earnings dates come from FMP. Why that works, and what each source can and cannot do, is in [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md).

## How it picks spreads

For each underlying that passes the earnings rule, per expiration in the DTE window:

1. **Earnings** (`src/earnings.ts`). The last report at least `minDaysSinceLast` days ago and the next at least `minDaysUntilNext` away. An unknown date fails. When sources disagree the nearer next date wins.
2. **Which contracts to quote** (`src/strikes.ts`). Neither broker filters a chain by delta, so the delta range is turned into a strike range from the spot and the IV index, and only those contracts (about 22 a symbol, against 74 for a broad pull) are requested.
3. **Pairing** (`src/spread.ts`). A short leg needs an absolute delta in `delta.min..delta.max`, must be out of the money, and every leg used must have a bid-ask within `maxLegSpreadPct` of its mid. The long leg is the first of `widths` that exists and passes. `fallbackWidth` is used for an expiration only when none of `widths` produced a spread.
4. **Odds and cost.** Credit at the mid and at the natural price, max risk, return on risk, and a chance of profit read from the delta at the break-even (not `1 - |delta| + credit / width`, which counts the credit twice).

## Configuration

`config/default.json` holds generic defaults. Put your own numbers in `config/local.json`, which is git-ignored and merged over the defaults key by key (arrays are replaced, not merged).

| Key | Meaning |
|---|---|
| `dte.min`, `dte.max` | Days-to-expiration window |
| `delta.min`, `delta.max` | Absolute delta of the short leg |
| `widths` | Spread widths in dollars, tried in order |
| `fallbackWidth` | Used only when none of `widths` gives a spread; `null` turns it off |
| `maxLegSpreadPct` | Largest (ask - bid) / mid, in percent, for any option used |
| `earnings.minDaysSinceLast`, `earnings.minDaysUntilNext` | The earnings rule |
| `strikeSelection` | Slack and margins for choosing which strikes to quote |

## What is not here yet

- Providers: tastytrade (OAuth, metrics, chain listing, quotes) and FMP (earnings calendar, daily bars).
- The ranking. The inputs are chosen (IV against realised volatility, IV percentile as context, the leg and slippage numbers above) but the formula is not.
- A command line, and a daily log of each run's inputs so a ranking can be checked against the volatility that followed.

## Development

Node 26 runs the TypeScript directly: no build step and no runtime dependencies.

```bash
npm ci
npm test            # node --test
npm run typecheck   # tsc, noEmit
```

Related: spread-book, a separate project, manages spreads once they are open. This project finds them.

Nothing here is investment advice.
