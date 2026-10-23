# Notes for agents

Things that surprised people before. The README says how the project works; this file is about what is not obvious from it. Add to it when something catches you out.

## Running TypeScript

- No build step and no `dist/`. Node 26 strips the types and runs `src/*.ts`, so imports carry the `.ts` extension and the code sticks to erasable syntax (`erasableSyntaxOnly`): no enums, namespaces or constructor parameter properties. `tsc` only type-checks, so run `npm run typecheck` as well as `npm test`.
- `tsconfig.json` has `noUncheckedIndexedAccess` on. `strikes.ts` indexes its coefficient tables through a small `at()` helper for that reason.

## Why there is no Schwab here

This started as part of a Schwab scanner and the Schwab login is the reason it is not. The sibling project that owns Schwab (equity-watch) has one weekly interactive login, and a second login probably revokes the first. tastytrade's refresh token does not expire and its REST quotes carry greeks and open interest, so this project needs no Schwab credentials at all. Do not add a Schwab provider "for cross-checking"; if a number needs checking, compare a saved response.

## Rules that look arbitrary and are not

- **The bid-ask rule is per option and applies to both legs.** `(ask - bid) / mid`, in percent, the figure OptionStrat prints as "Wide bid/ask spread (67%)". It is not a limit on what the spread costs to fill: two legs at 20% each can lose 30% to 70% of the credit, because the credit is the difference of two mids. That cost is reported as `slippagePct`, not gated.
- **Open interest is not the liquidity gate.** It passes options that are 67% wide (OI 1,330) and fails ones that trade tightly (OI 205). Do not add an open-interest floor as a "sanity check" without asking.
- **The chance of profit is read from the delta at the break-even.** `1 - |short delta| + credit / width` counts the credit twice and reads high. The delta method matched OptionStrat (67.1% against 67%) on the one spread checked.
- **Every available width in `width.min..width.max` is a candidate; the report filters.** Choosing a width in the code was tried (first width that works, a $10 fallback) and dropped on the user's say-so. A wider spread did not beat a $5 one on return on risk in any of 40 cases checked, so the filter will usually pick narrow, but that is the reader's call.
- **Unknown earnings dates fail.** A name with no date on file may report tomorrow.
- **The next report is the earliest future date across sources.** The two sources disagreed by more than a day on about one symbol in twenty.
- **Only out-of-the-money legs.** Providers' greeks and IVs diverge deep in the money (an IV of 34% against 19% for one contract).

## Data traps (details in docs/DATA_SOURCES.md)

- tastytrade `market-metrics` mixes units: fractions for the IV index and ranks, percent for the 30-day IV and historical volatilities.
- `earnings.expected-report-date` is the last report once a company has reported. Split dates around today (`splitReportDates`).
- FMP's earnings calendar silently truncates at 4,000 rows. Window it.
- A quote band must extend past the target strike by the widest spread width, or the long legs are never quoted.
- Quotes are only live in the regular session. After the close they are the last prices, not a market.

## The ranking is a guess, and says so

`src/rank.ts` scores candidates with weights nobody has validated. Do not describe it as finding "the best" spreads. The components are ranked (0 to 1) rather than combined raw so that a weight means the same thing whatever the units; underlying-level components are ranked across underlyings, never across spreads. `src/validate.ts` is how the weights get checked, and it needs weeks of saved runs. If you change a component's definition, old runs in `runs/` stop being comparable.

- `validate` judges a spread only by where the underlying was at the exit date (21 days before expiry). It does not reprice the options.
- The same spread listed on many days is one trade, counted at its first listing.
- Historical volatility from daily bars uses a calendar window (22 trading-day returns for "30 days"), which matches tastytrade's 30-day figure to about a point. It drifts more at 60 and 90 days when one jump sits in the window.

## The report page (web/)

Plain files, no bundler and no framework, so it opens from a `file://` URL. `model.js` has no DOM in it and is a classic script (not a module: Chrome blocks module scripts on `file://`); `test/web.test.ts` runs it in `node:vm` and checks its scoring against `src/rank.ts` over random inputs. Change one copy of the scoring and that test fails until you change the other.

- **The scan is embedded in index.html** by `renderReport` (`src/report.ts`). It escapes `<` and the two Unicode line separators: a `</script>` inside a symbol's data would otherwise end the data tag. Do not replace that with a plain `JSON.stringify`.
- **Columns drop out by the table's own width, with container queries on `.table-wrap`, not by the window's width.** The rail is a fixed 17.5rem, so a window width says little about the room the table has: a media query tuned at 1440px clipped the score column at 1360px. The thresholds (1150px, 890px, 700px) are the measured widths of the columns; re-measure if you add one.
- **The opened row must never widen the table.** `.detail-grid` has `contain: inline-size`, `width: 100%` and `minmax(0, 1fr)` columns. Without them the legs table pushed the score column off a phone.
- **Palette and theme are equity-watch's, copied.** `web/palette.js` is that file with one line changed (the storage key). The three-colour system (`--p-ground`, `--p-ink`, `--p-signal`, light mode swaps ground and ink) is why every colour in `index.html` is a `color-mix` of those three; add a colour that way, never as a hex.
- **The rail footer is sticky and holds the swatch's place** (the swatch is `position: fixed` at the lower left). Without it the swatch floats over the last filter.
- **Check layout changes in a real browser at 320, 390, 1000, 1360 and 1520px**, with a row opened. Every width bug found so far was invisible at the width it was written at.

## Dates and time zones

Earnings logic works on date strings (`YYYY-MM-DD`) so no zone enters it, but "today" must be the New York date: a UTC date is already tomorrow during the evening session. Pass it in; do not read the clock inside the logic (`pairSpreads` and the earnings functions take everything they need as arguments, which is what keeps the tests fixed).

## Config and personal data

`config/default.json` is committed and generic. Real thresholds live in `config/local.json`, which is git-ignored. Keep credentials, account numbers and any personal criteria out of everything committed, history included. Credentials belong in a file outside the repository.

## Tests

`test/fixtures.ts` builds its own config so tests do not move when the defaults do. When changing a rule, break it on purpose first and check a test fails: the rules above were each verified that way.

## Related projects

- `spread-book` manages spreads once open (exit rules, greek concentration) from OptionStrat exports. They share no code yet.
- `schwab-creditspreadscanner` is the earlier, Schwab-based attempt at this. It is not maintained alongside this one.
