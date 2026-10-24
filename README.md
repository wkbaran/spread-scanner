<div align="center">

# Spread Scanner

**Which credit spreads are worth opening today, and how likely are their options to be overpriced?**

Scans the whole optionable market, or a list you give it, for bull put and bear call spreads, drops the names that are about to report earnings, keeps the options that trade tightly, and ranks what is left by how rich implied volatility is against what the stock actually does.

![Node 26+](https://img.shields.io/badge/node-26%2B-339933?logo=nodedotjs&logoColor=white)
![TypeScript](https://img.shields.io/badge/TypeScript-native-3178C6?logo=typescript&logoColor=white)
![No runtime dependencies](https://img.shields.io/badge/dependencies-0-informational)
![Data: tastytrade + FMP](https://img.shields.io/badge/data-tastytrade%20%2B%20FMP-00A0DF)
![Status: early](https://img.shields.io/badge/status-early-lightgrey)

[What it uses](#what-it-uses) · [How it picks spreads](#how-it-picks-spreads) · [Using it](#using-it) · [The report](#the-report) · [Configuration](#configuration) · [Running it on a schedule](#running-it-on-a-schedule) · [Status](#status) · [Data sources](docs/DATA_SOURCES.md)

<img src="docs/screenshots/overview.png" alt="The Spread scanner report: the ranked spreads with a strike ruler on each row, one row opened to show its legs, its underlying and why it scores what it does" width="900">

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

**Which underlyings.** With no list given, the scan starts from every optionable stock and fund (about 6,000, from tastytrade's catalogue) and narrows by what one metrics call already says, before any chain is fetched:

1. tastytrade's **liquidity rating** of at least `universe.minLiquidityRating` (4 by default, about 550 names). It is the cheapest stand-in for the bid-ask rule below: most names under it fail that rule anyway.
2. The **earnings rule**, below.
3. The richest `universe.maxNames` (250 by default) by IV percentile and IV over realised volatility, so the expensive calls go to the names the ranking would favour. Names with no historical volatility are judged on the percentile alone.

The scan prints and saves the counts at each step (`funnel`) rather than listing thousands of names. A list given with `--symbols` or `--symbols-file` is scanned exactly, never thinned.

For each underlying that is left, per expiration in the DTE window:

1. **Earnings** (`src/earnings.ts`). The last report at least `minDaysSinceLast` days ago and the next at least `minDaysUntilNext` away. An unknown date fails. When sources disagree the nearer next date wins.
2. **Which contracts to quote** (`src/strikes.ts`). Neither broker filters a chain by delta, so the delta range is turned into a strike range from the spot and the volatility the options actually trade at, and only those contracts (about 25 a symbol, against 74 for a broad pull) are requested. That volatility is read from one probe contract per side and expiration, because the IV index is an at-the-money figure and a wing can sit far from it: SPY's index was 19.8% while its calls at 0.2 delta traded near 13%.
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
| `universe.minLiquidityRating`, `universe.maxNames` | The funnel for a scan with no list: the lowest tastytrade liquidity rating (1 to 5) and the most names that go on to chains and quotes |
| `display.timeZone` | Zone for the scan time shown in the report (default `America/Denver`); dates are unaffected |
| `strikeSelection` | Slack and margins for choosing which strikes to quote. `rateFromSofr` (on by default) takes the risk-free rate from the latest SOFR, published free by the New York Fed and cached for the day; `rate` is the fallback if that cannot be fetched. The rate each run used is saved in it |

## Using it

```bash
# credentials go in a file outside the repository (see "Credentials" below)
node src/cli.ts scan                                  # every optionable name, through the funnel
node src/cli.ts scan --symbols SPY,QQQ,IWM,GLD        # or --symbols-file watchlist.txt: exactly those
node src/cli.ts validate                              # once runs are weeks old
```

`scan` prints what it dropped and why, then the best candidates (the best three per underlying by default), and writes the whole ranked result to `runs/`. A scan from the whole market takes about 25 seconds, most of it the chain listings, which are cached for the day.

### The report

```bash
node src/cli.ts report        # the latest scan in runs/ -> report/index.html
```

One self-contained page: open `report/index.html` straight from disk, no server. The scan is embedded in it.

- **Every row has a strike ruler.** The line is the stock, the shaded band is one expected move either side of it (the short option's own IV over the days left, the volatility its delta was computed with), and the bar runs from the short strike to the long strike. Puts sit left of the stock and calls right, on one shared scale of plus or minus 1.5 expected moves (an arrow marks a strike beyond it), so rows compare at a glance. A short strike at 0.15 to 0.25 delta sits at roughly 0.7 to 1 expected move by construction, so most spreads land inside the band.
- **Filters** for side, spread width (a chip for each width the scan found), expiration, stocks or funds, and minimums or maximums on return, chance of profit, IV percentile, IV over realised vol, slippage and the widest bid-ask. The list shows the best three of each symbol unless you ask for more.
- **Weight sliders** re-rank the list as you move them. Open a row to see its legs with their greeks and the net greeks of the spread, the underlying's figures and how each component ranked. Hover a column title for what it means.
- **A palette picker and a Light/Dark button**, the same control as equity-watch's.

The page works down to a 320px phone. Every column is always there: when the table is wider than its room it scrolls sideways, with the symbol and the score pinned either side, and the opened row stays in view while it does.

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

## Running it on a schedule

`docker/` runs the scan four times every weekday in a container, saves each ranked result to `runs/` (the log `validate` reads), rebuilds the report and publishes it:

```bash
node src/cli.ts publish      # upload report/ to S3 (S3_BUCKET, AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY)
```

`infra/cloudformation.yaml` creates the site: a private S3 bucket, CloudFront with a certificate, a Route 53 alias on your domain, an optional password prompt, and a publisher that can only write objects. [docker/README.md](docker/README.md) has the setup, from the stack to the first scheduled run. The publisher signs its own requests, so it adds no dependency.

## Status

Early. Written and tested: the earnings rule, strike selection, spread pairing, the tastytrade and FMP providers, the scan, the ranking, the validation, the browser report, and the container and stack that run and publish it. The weights are still a guess until `validate` has weeks of runs to check them against.

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
