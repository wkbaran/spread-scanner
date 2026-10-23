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
- **The fallback width is for an expiration where no `widths` spread exists**, not a second pass over every short strike. A wider spread did not beat a $5 one on return on risk in any of 40 cases checked.
- **Unknown earnings dates fail.** A name with no date on file may report tomorrow.
- **The next report is the earliest future date across sources.** The two sources disagreed by more than a day on about one symbol in twenty.
- **Only out-of-the-money legs.** Providers' greeks and IVs diverge deep in the money (an IV of 34% against 19% for one contract).

## Data traps (details in docs/DATA_SOURCES.md)

- tastytrade `market-metrics` mixes units: fractions for the IV index and ranks, percent for the 30-day IV and historical volatilities.
- `earnings.expected-report-date` is the last report once a company has reported. Split dates around today (`splitReportDates`).
- FMP's earnings calendar silently truncates at 4,000 rows. Window it.
- A quote band must extend past the target strike by the widest spread width, or the long legs are never quoted.
- Quotes are only live in the regular session. After the close they are the last prices, not a market.

## Dates and time zones

Earnings logic works on date strings (`YYYY-MM-DD`) so no zone enters it, but "today" must be the New York date: a UTC date is already tomorrow during the evening session. Pass it in; do not read the clock inside the logic (`pairSpreads` and the earnings functions take everything they need as arguments, which is what keeps the tests fixed).

## Config and personal data

`config/default.json` is committed and generic. Real thresholds live in `config/local.json`, which is git-ignored. Keep credentials, account numbers and any personal criteria out of everything committed, history included. Credentials belong in a file outside the repository.

## Tests

`test/fixtures.ts` builds its own config so tests do not move when the defaults do. When changing a rule, break it on purpose first and check a test fails: the rules above were each verified that way.

## Related projects

- `spread-book` manages spreads once open (exit rules, greek concentration) from OptionStrat exports. They share no code yet.
- `schwab-creditspreadscanner` is the earlier, Schwab-based attempt at this. It is not maintained alongside this one.
