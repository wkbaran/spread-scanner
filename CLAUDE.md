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
- **Every column is always shown; a table wider than its room scrolls sideways** (the user's call, 2026-10-23: columns that dropped out by width hid the chance of profit and the IV percentile on most windows). The symbol and the score are pinned either side with `position: sticky`, so a row stays readable and keeps its score. Column order in `COLUMNS` is therefore priority order: what decides a trade (return, chance of profit, IV percentile) comes before the wide strike ruler. The pinning rules use child combinators from `.table-wrap` because an opened row holds a second table (the legs), whose headers must not be pinned. Pinned cells need an opaque background of their own, so the row's hover and open colour reaches them through `--row-bg`. On a wide window the wrapper is also the vertical scroller (`max-height`), so the header row can stay put; below 860px the page scrolls instead. `.table-wrap` is still a size container, now only to compact the rows (`.days`, the tag, font size) and to size the opened row's panel (`100cqw`, sticky) so it stays on screen while the table is scrolled.
- **The opened row must never widen the table.** `.detail-grid` has `contain: inline-size`, `width: 100%` and `minmax(0, 1fr)` columns. Without them the legs table pushed the score column off a phone.
- **The palette control is equity-watch's, copied; the presets are this app's own.** `web/palette.js` is that file with a different storage key and its own six presets (the user asked for new ones here, and for the originals to stay on equity-watch only). `index.html`'s `data-palette` must equal the first preset (`test/web.test.ts` checks it), or the picker opens on a palette it does not list. The three-colour system (`--p-ground`, `--p-ink`, `--p-signal`, light mode swaps ground and ink) is why every colour in `index.html` is a `color-mix` of those three; add a colour that way, never as a hex.
- **The rail footer is sticky and holds the swatch's place** (the swatch is `position: fixed` at the lower left). Without it the swatch floats over the last filter.
- **Check layout changes in a real browser at 320, 390, 1000, 1360 and 1520px**, with a row opened. Every width bug found so far was invisible at the width it was written at.

## Which strikes to quote: size the band from the wing, not the IV index

`scan` quotes only the contracts a short or long leg could be, and works out which from the delta band. That needs a volatility, and the obvious one, tastytrade's 30-day IV index, is wrong: it is an at-the-money figure, and the options at 0.15 to 0.25 delta can trade at a very different level (SPY, 2026-10-23: index 19.8%, calls near 13%). Sized from the index, the band started four strikes too far out and never requested the 789 and 790 calls, which sit at 0.22 and 0.215 delta. The best-paying spreads in the user's own range were missing, found only because the user compared a row against OptionStrat.

The risk-free rate in that calculation is the latest SOFR from the New York Fed (`src/providers/nyfed.ts`, `src/rate.ts`: no key, cached 20 hours), so the tool follows interest rates without anyone editing a config. It must never stop a scan: a failed or implausible fetch falls back to `strikeSelection.rate` and says so in the log, and the run saves which it used (`rate` in the result, and the resolved value in its embedded `config`). The rate only places the band. The chance of profit is read from tastytrade's deltas, which carry tastytrade's own rate, so changing this cannot move a PoP.

So `scan` makes two quote requests: first one probe contract per name, side and expiration, at the near edge of an index-sized band; then the real band, sized from the probe's own implied volatility (`MIN_WING_SIGMA` guards a stale print, and the index is the fallback). The probe is not requoted. Do not go back to one request: the test `the strike band follows the volatility the options trade at` fails if you do. A wider fixed margin is not a substitute, because the gap between index and wing varies by name and by day.

## The simulated outcome (src/outcome.ts) is not the chance of profit

"Chance of profit" is the chance of finishing profitable at expiration, read from the delta at the break-even. Someone who takes profit at 50% and stops out never holds that long, so it is not their win probability. `outcome` simulates the managed trade instead: paths of the stock (Monte Carlo, one fixed seed shared by every candidate, so a run is repeatable and candidates are compared on the same markets), both legs repriced by Black-Scholes at their own implied volatility, a resting order at the profit target (fills at its price), a stop checked at each close (fills where the market is), a time exit before expiration. It reports the win rate, the win rate at which the average win and loss cancel, and the average result. Things that look like bugs and are not:

- **With free fills at fair prices the result is at most zero, not exactly zero.** A resting order fills at its price but a stop fills past its level after a gap, so early exits can only cost a little. `test/outcome.test.ts` asserts exactly zero only for the case with no such asymmetry, and "never positive, bounded below" for the rest. Do not "fix" it to be symmetric.
- **`ivDecay` exists because a flat-volatility model understates how often a profit target is reached.** Real option volatility drifts down as a position ages (the term structure usually slopes up and the position rolls down it), which this models as each leg's IV falling linearly to (1 - ivDecay) of itself by the exit. It was calibrated, not derived: against a real record of closed spreads, a decay of roughly a third brought the simulated win rate, target rate, break-even rate and average result per spread to within a few points, where the flat model was far off on how often the target is reached. That record is personal and is not in the repository; the value lives in the git-ignored `config/local.json`, and `config/default.json` keeps 0. Whoever manages trades differently should re-calibrate against their own record before trusting the numbers, and one record fitted with one parameter is not proof the model predicts the next trade.
- **The stop is a quarter of the most you can lose** because that is the written rule; the owner's realised losses average a third of it, since stops are checked at the close and gap through. The simulation reproduces the gap on its own (daily monitoring), and still lands a little short on the average loss.
- **`volEdge` defaults to 0 on purpose.** Drawing the stock at its recent realised volatility would make every name with IV over realised look like a free lunch, which a real record of trades does not support. It is there to be raised deliberately.
- **It is not in the score.** The ranking weights are unchanged; the three figures are columns (`managedWin`, `needs`, `ev`) the owner can sort by. Folding the edge into the ranking is a separate decision.

## The report's starting filters, and the saved view

The "Keep only" fields start at `display.filters` from the scan's own embedded config (`M.defaultFilters`), so a person's criteria live in their git-ignored `config/local.json` and change with the next scan. The page remembers each viewer's filters, weights and sort in localStorage (`spread-scanner.view`, not cookies: per browser, never sent anywhere). The remembered filters carry a `defaultsKey`, and are dropped when it differs from the current starting points: without that, a view saved before a default existed would hide it forever. Weights and sort are kept either way. The defaults only hide rows on the page; the scan and the saved run keep every candidate. They are not the ranking: the score ignores them. IV percentile is *not* a "too volatile" measure (it says how rich IV is against the stock's own year, with no ceiling on absolute volatility); see the notes in equity-watch's SPREAD_SCREENER_NOTES.md, section 5.

## OptionStrat links

`optionStratUrl` in `web/model.js` builds `https://optionstrat.com/build/<bull-put-spread|bear-call-spread>/<SYMBOL>/.<SYMBOL><YYMMDD><P|C><strike>,-.<SYMBOL>...`: the leg bought first, the leg sold with a leading minus. The user supplied one put example; a call spread and a half-dollar strike were checked by opening them on the site and reading the page title ("SPY Dec 4th 795/790 Bear Call Spread"). OptionStrat's site refuses plain HTTP fetches (403), so a check needs a real browser. The table or graph view is not in the link: the site keeps it in the visitor's localStorage (`displayType`), and the user is happy with their own default. Symbols that are not plain letters (BRK/B) get no link, because the option root can differ from the stock's.

## No watchlist: the funnel

A scan with no `--symbols` starts from every optionable stock and fund (`Tastytrade.optionableEquities`, about 6,000 of the catalogue's 13,000: those with `option-tick-sizes` and not closing-only) and narrows it in `scan` when `deps.funnel` is set. Things that look simplifiable and aren't:

- **The liquidity rating is a hard cut before anything else, and it is counted, not listed.** It is the cheap stand-in for the 20% bid-ask rule, which needs quotes. Without it the cap below fills with illiquid names that have the richest IV and then fail the bid-ask rule, leaving few results. (`is-illiquid` on the instrument is a different, stricter flag: it excludes names rated 3 and 4. Do not use it for this.)
- **The cap sorts by the underlying-level components only** (`preScores` in `src/rank.ts`: IV percentile, IV over tastytrade's realised vol). It must not call FMP for bars: about half of names have no tastytrade historical vol, and bars are one call each against a 250-a-day key that equity-watch also draws on.
- **Names the funnel cut are counted in `funnel`, never in `dropped`.** `dropped` is for names someone might wonder about. Thousands of names there would bury it and bloat every saved run.
- **An explicit list is never thinned.** `funnel` is a flag on the scan, not a property of the config, so `--symbols` gives exactly what was asked for.
- **There is no monthly-only rule: weeklies, monthlies and quarterlies all count, and the only expiration filter is the DTE window.** The window's calendar still decides what a day finds. A monthly falls inside 37 to 45 days only about nine days a month. On the other days a name is found only if it has a weekly in the window, and weeklies on most single stocks are thin, so the 20% bid-ask rule removes them (the drop list says which: "no expiration in the DTE window" for names with only monthlies, "short leg bid-ask too wide" for thin weeklies). A scan on such a day finds few spreads. That is the rules working, and is why the scan runs every weekday.

## Running it: the container, the stack and the publisher

- **Everything the scanner writes goes under `SPREAD_SCANNER_STATE_DIR`** (`stateDir` in `src/cli.ts`): `runs/`, `report/`, `.cache/` and `config/local.json`. It defaults to the repository, which is why nothing changes for a checkout. The image sets it to `/data`, a bind mount, so the code (`/app`) and the data can be replaced separately. `config/default.json` and `web/` are always read from the code, never from the state directory.
- **There is no `npm install` in the image and no build stage.** The project has no runtime dependencies and Node 26 runs the `.ts` files. Adding a runtime dependency would change both; the S3 publisher (`src/s3.ts`) signs with `node:crypto` for that reason. Its tests include AWS's two documented worked examples, so a wrong canonical request fails there instead of as a 403 from S3.
- **The publisher only PUTs.** The report is a few fixed files, so there is no listing, sync plan or delete, and the stack's IAM user has `s3:PutObject` and nothing else. `index.html` goes last so a page never points at assets that are not up yet. A renamed asset would leave the old one behind in the bucket; delete it by hand.
- **One time zone, Mountain, everywhere a person reads a time** (the user's call, 2026-10-23: "I don't like having some times in different timezones in my services because that gets confusing fast"; they do not treat their zone as private, whatever the global rule says). The crontab, the container's `TZ` (Dockerfile) and the report's scan stamp (`display.timeZone`, default `America/Denver`) all use it, the same as equity-watch. Do not reintroduce a market-clock `CRON_TZ` or a second zone for logs. Market logic is separate and stays New York (`easternDate`, below): that is a date, not a time anyone reads. The scans are at 7:40, 9:30, 11:30 and 13:20, which is 9:40, 11:30, 13:30 and 15:20 in New York; the two zones change clocks on the same dates, so that holds all year. There is no holiday calendar: a holiday scan saves a run that repeats the day before.
- **The stack is modelled on equity-watch's** (`infra/cloudformation.yaml`) without the ops queue and Lambda. Keep the same rules: `CustomDomain` is undefaulted because this is a public repo, and `scripts/deploy-stack.sh` passes every parameter each time because a bare `aws cloudformation deploy` would drop the domain and certificate. Never commit `.env`, the domain, a hosted zone id or the docker host's address; use placeholders in docs.
- **The page embeds the scan, and the scan carries the user's thresholds.** On a public site that publishes them. `EnableBasicAuth` exists for that.

## The expected move is the short option's own, not the IV index's

The ruler's band, the "distance from the stock" figure and the `distance` component all measure in expected moves: one standard deviation, spot x IV x sqrt(years). The IV must be the short option's own (`spread.short.iv`), the volatility its delta was computed with. Then a strike at 0.16 delta sits at the band's edge, 0.20 at about 0.84 of it and 0.25 at about 0.67, so the user's 0.15 to 0.25 delta range puts every short strike at roughly 0.7 to 1.0 expected moves: inside the band, by construction, and the ruler shows it consistently. Drawn from the IV index instead (an at-the-money figure, 19.8% for SPY against 13% at the calls that were traded) the same strikes read as 0.47 to 1.28, and 98% looked inside. The index is only the fallback when an option has no IV. `web/model.js` and `src/rank.ts` each carry the rule; a test pins each.

The ruler is drawn in expected moves, so the band is always the same fraction of its width, and a different IV only moves the strikes.

## Dates and time zones

Earnings logic works on date strings (`YYYY-MM-DD`) so no zone enters it, but "today" must be the New York date: a UTC date is already tomorrow during the evening session. Pass it in; do not read the clock inside the logic (`pairSpreads` and the earnings functions take everything they need as arguments, which is what keeps the tests fixed).

## Config and personal data

`config/default.json` is committed and generic. Real thresholds live in `config/local.json`, which is git-ignored. Keep credentials, account numbers and any personal criteria out of everything committed, history included. Credentials belong in a file outside the repository.

## Tests

`test/fixtures.ts` builds its own config so tests do not move when the defaults do. When changing a rule, break it on purpose first and check a test fails: the rules above were each verified that way.

## Related projects

- `spread-book` manages spreads once open (exit rules, greek concentration) from OptionStrat exports. They share no code yet.
- `schwab-creditspreadscanner` is the earlier, Schwab-based attempt at this. It is not maintained alongside this one.
