<div align="center">

# Spread Scanner

**Which credit spreads are worth opening today, and how likely are their options to be overpriced?**

Scans a watchlist for bull put and bear call spreads, drops the names that are about to report earnings, keeps the options that trade tightly, and ranks what is left by how rich implied volatility is against what the stock actually does.

![Node 26+](https://img.shields.io/badge/node-26%2B-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-native-3178C6?logo=typescript&logoColor=white)
![No runtime dependencies](https://img.shields.io/badge/dependencies-0-informational)
![Data: tastytrade + FMP](https://img.shields.io/badge/data-tastytrade%20%2B%20FMP-00A0DF)
![Status: early](https://img.shields.io/badge/status-early-lightgrey)

[What it uses](#what-it-uses) · [How it picks spreads](#how-it-picks-spreads) · [Configuration](#configuration) · [Status](#status) · [Development](#development) · [Data sources](docs/DATA_SOURCES.md)

</div>

## What it uses

| What | Service | Needed? |
|---|---|---|
| Runtime | Node.js 26, which runs the TypeScript directly | Yes |
| IV rank and percentile, option chains, quotes, greeks, open interest, next earnings date | [tastytrade API](https://developer.tastytrade.com/) (OAuth, read-only scope; real-time data needs a funded account) | Yes |
| Earnings dates, daily price history | [Financial Modeling Prep](https://site.financialmodelingprep.com/) (the free tier is 250 calls a day) | Yes |
| Type checking | `typescript`, a dev dependency | Only for `npm run typecheck` |

There is no Schwab dependency. [docs/DATA_SOURCES.md](docs/DATA_SOURCES.md) has what each source returns, its limits, and the traps in the data.

## How it picks spreads

For each underlying that passes the earnings rule, per expiration in the DTE window:

1. **Earnings** (`src/earnings.ts`). The last report at least `minDaysSinceLast` days ago and the next at least `minDaysUntilNext` away. An unknown date fails. When sources disagree the nearer next date wins.
2. **Which contracts to quote** (`src/strikes.ts`). Neither broker filters a chain by delta, so the delta range is turned into a strike range from the spot and the IV index, and only those contracts (about 22 a symbol, against 74 for a broad pull) are requested.
3. **Pairing** (`src/spread.ts`). A short leg needs an absolute delta in `delta.min..delta.max`, must be out of the money, and every leg used must have a bid-ask within `maxLegSpreadPct` of its mid. Every usable long leg between `width.min` and `width.max` dollars past it is a candidate, so one short strike can give several spreads. The report filters by width.
4. **Odds and cost.** Credit at the mid and at the natural price, max risk, return on risk, and a chance of profit read from the delta at the break-even (not `1 - |delta| + credit / width`, which counts the credit twice).

## Configuration

`config/default.json` holds generic defaults. Put your own numbers in `config/local.json`, which is git-ignored and merged over the defaults key by key (arrays are replaced, not merged).

| Key | Meaning |
|---|---|
| `dte.min`, `dte.max` | Days-to-expiration window |
| `delta.min`, `delta.max` | Absolute delta of the short leg |
| `width.min`, `width.max` | Spread widths in dollars; every available width in the range is a candidate |
| `maxLegSpreadPct` | Largest (ask - bid) / mid, in percent, for any option used |
| `earnings.minDaysSinceLast`, `earnings.minDaysUntilNext` | The earnings rule |
| `strikeSelection` | Slack and margins for choosing which strikes to quote |

## Using it

```bash
# credentials go in a file outside the repository (see "Credentials" below)
node src/cli.ts scan --symbols SPY,QQQ,IWM,GLD        # or --symbols-file watchlist.txt
node src/cli.ts validate                              # once runs are weeks old
```

`scan` prints what it dropped and why, then the best candidates (the best three per underlying by default), and writes the whole ranked result to `runs/`. A 45-symbol scan takes a few seconds with the chain listings cached.

### Ranking

Each candidate gets six component ranks and a weighted average of them (weights in `ranking.weights`):

| Component | Level | Better when |
|---|---|---|
| `ivPercentile` | underlying | IV is high against its own year |
| `ivOverHv` | underlying | IV is high against recent realised volatility (the average of the 30, 60 and 90-day figures) |
| `returnOnRisk` | spread | the credit at the natural price is large against the money at risk |
| `pop` | spread | the chance of profit, from the delta at the break-even, is high |
| `legSpread` | spread | the worse leg's bid-ask is tight |
| `distance` | spread | the short strike is far from the stock, in expected moves (weight 0 by default) |

Underlying-level components are ranked across underlyings, so a name with forty spreads does not count forty times. **The weights are a first guess.** That is what `validate` is for: every run keeps its inputs, and once runs are a few weeks old it compares IV with the volatility that followed, and each score quintile with how its spreads held up at the exit date.

### Credentials

`~/.config/spread-scanner/credentials.env` (or `--credentials FILE`, or environment variables):

```
TT_CLIENT_SECRET=...
TT_REFRESH_TOKEN=...
FMP_API_KEY=...
```

Create a tastytrade OAuth client with the `read` scope only; the scanner never places orders.

## Status

Early. Written and tested: the earnings rule, strike selection, spread pairing, the tastytrade and FMP providers, the scan, the ranking and the validation. Still to come: a browser report with filters and a theme picker, and scheduled runs.

## Development

Node 26 runs the TypeScript directly: no build step and no runtime dependencies.

```bash
npm ci
npm test            # node --test
npm run typecheck   # tsc, noEmit
```

Related: spread-book, a separate project, manages spreads once they are open. This project finds them.

## Disclaimer

Nothing here is investment advice. Option data can be stale or wrong; check a trade with your broker before acting on it.
