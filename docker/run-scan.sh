#!/bin/bash
# One scheduled run, as supercronic starts it: scan, rebuild the report, publish it,
# then ping HEALTHCHECK_URL (<url> on success, <url>/fail otherwise). supercronic does not start a
# run while the previous one is still going.
#
# A failed scan skips the rest: there is nothing new to report, and publishing would only restamp
# the last good page. The report and the publish are separate steps so a failed upload does not
# lose the run that was just saved.
set -u
# The code sits beside this script; the state is the volume (the image sets SPREAD_SCANNER_STATE_DIR).
APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
cd "${SPREAD_SCANNER_STATE_DIR:-$APP_DIR}" || exit 2

cli() { node "$APP_DIR/src/cli.ts" "$@"; }

# Stamp the log in the container's own zone, not the schedule's (see entrypoint.sh).
[ -z "${CONTAINER_TZ:-}" ] || export TZ="$CONTAINER_TZ"
echo "=== $(date -Is) ==="

# With no watchlist the scan starts from every optionable stock and fund and narrows it itself
# (config "universe"). A watchlist.txt in the state directory, if you put one there, is scanned
# instead and is never thinned.
watchlist="${WATCHLIST_FILE:-watchlist.txt}"
args=()
if [ -f "$watchlist" ]; then
  echo "Scanning only the symbols in $PWD/$watchlist."
  args=(--symbols-file "$watchlist")
else
  echo "No watchlist: scanning every optionable stock and fund through the funnel."
fi

code=0
cli scan ${args[@]+"${args[@]}"} --limit 15 || code=$?
if [ "$code" -eq 0 ]; then
  cli report || code=$?
fi
if [ "$code" -eq 0 ]; then
  if [ -n "${S3_BUCKET:-}" ]; then
    cli publish || code=$?
  else
    echo "S3_BUCKET is not set: built the report but did not publish it."
  fi
fi

if [ -n "${HEALTHCHECK_URL:-}" ]; then
  suffix=""
  [ "$code" -eq 0 ] || suffix="/fail"
  curl -fsS -m 10 --retry 3 -o /dev/null "${HEALTHCHECK_URL%/}$suffix" || echo "healthcheck ping failed"
fi

[ "$code" -eq 0 ] || echo "run exited $code"
exit "$code"
