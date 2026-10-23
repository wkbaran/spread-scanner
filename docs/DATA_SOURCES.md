# Data sources

Verified 2026-10-23 against live responses, with a read-only OAuth client. Re-check before relying on a number: vendors change these.

## tastytrade (REST, `https://api.tastyworks.com`)

**Auth.** OAuth client with the `read` scope only. `POST /oauth/token` with `grant_type=refresh_token`, the refresh token and the client secret. The refresh token does not expire; the access token lasts 15 minutes. Every request needs a `User-Agent` of the form `product/version` or it gets a 401. Credentials for the sandbox (`api.cert.tastyworks.com`) do not work on production.

**Market metrics** — `GET /market-metrics?symbols=A,B,...`
- 564 symbols in one call worked (0.4 s, 1.6 MB). No limit found; none documented.
- Fields used: `implied-volatility-index`, `implied-volatility-index-rank`, `implied-volatility-percentile`, `implied-volatility-30-day`, `historical-volatility-30-day` / `60-day` / `90-day`, `beta`, `liquidity-rating`, `earnings.expected-report-date`, `earnings.time-of-day`.
- **Units are mixed.** The IV index, ranks and percentile are fractions (0.287 is 28.7%). `implied-volatility-30-day` and the historical volatilities are already percent.
- **`expected-report-date` is the last report once a company has reported**, not the next one. A date before today means "reported".
- IV index, rank and percentile were present for about 98% of 564 symbols; the 30-day IV and historical volatilities for about 58%. `earnings.estimated` was false for every symbol, so it says nothing.
- `dividend-next-date` can be years stale. The IV index reaches over 1,000% on illiquid names. The per-expiry IV for an expiry that is today is meaningless.
- The IV index agrees with the at-the-money IV from Schwab's chain: median difference 0.9 points over 24 names.

**Chains** — `GET /option-chains/{symbol}/compact` lists every contract symbol (50 to 140 KB, about 1.2 s) in two items, `Weekly` and `Regular`, with no prices. Symbols are OCC: the root padded to six characters, `YYMMDD`, `C` or `P`, the strike times 1000 in eight digits (`NFLX  261120P00061000`). There are no query filters. Cache the listing for the day.

**Quotes** — `GET /market-data/by-type?equity-option=<symbols>` (and `equity=`).
- At most 100 symbols per request across all the type parameters. Percent-encode the spaces in option symbols. Real time; the docs say it is for funded accounts.
- An option quote carries `bid`, `ask`, `bid-size`, `ask-size`, `mark`, `mid`, `last`, `volume`, `open-interest`, `delta`, `gamma`, `theta`, `vega`, `rho`, `volatility` (a fraction) and `theo-price`.
- Against Schwab on the same ten contracts: bid, ask, open interest and volume identical (the same exchange feed); delta and IV each provider's own. Out of the money they agree closely; **deep in the money they diverge badly**, so use only out-of-the-money legs.
- There is no server-side filter by delta, strike or expiry. Select contracts by symbol.

**Limits.** No request-rate numbers are published and a 429 carries no headers. About one call a second drew none. The docs suggest staying well under 50 a second and caching chains.

## FMP (`https://financialmodelingprep.com/stable`)

- **Earnings calendar** `earnings-calendar?from=&to=`: capped at **4,000 rows, and when a range holds more it silently returns only the latest dates.** A 45-day range lost AAPL's report. Use 3-day windows (the busiest held 2,018 rows). `includeReportTimes=true` adds `time` (`amc` / `bmo`) and `confirmed`.
- **Per symbol** `earnings?symbol=`: the next date (with `epsActual` null) and the history, 33 KB.
- Against Schwab's last-earnings date for 453 symbols: 435 identical, 14 a day off (before-open vs after-close), one genuinely different, three funds with none.
- Against tastytrade's report date for 391 symbols with a date in both: 362 identical, 11 a day apart, 18 more than a day apart. Neither is verified as the truth.
- **Daily bars** `historical-price-eod/full?symbol=&from=&to=`: 252 rows, 55 KB. Closes within 0.012% of Schwab's on 251 dates for two names.
- The free tier is 250 calls a day.

## Choosing strikes without a delta filter

Quote only the strikes a short leg could have. For the delta range, take the strike at each edge from the spot and the IV index (`strikeAtDelta`), pad by a fraction of an expected move for skew, then add the strike each possible width away. **The band must reach past the short strike by the widest width**: the first version missed every long leg on a $66 stock.

Measured on ten names, one expiry: every short the broad pull (spot plus or minus 1.7 expected moves, plus or minus $10) found was found again, with 22 contracts a symbol instead of 74, which is four symbols to a 100-symbol call.
