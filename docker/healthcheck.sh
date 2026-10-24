#!/bin/sh
# Healthy while the scheduler is alive: the crontab's 15-minute heartbeat is still being touched.
# This does not say the last scan worked (a failed run exits non-zero and pings HEALTHCHECK_URL/fail).
set -eu
# Three missed 15-minute ticks plus slack.
[ -n "$(find /tmp/alive -mmin -50 2>/dev/null)" ]
