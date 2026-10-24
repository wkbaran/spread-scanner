#!/bin/sh
# Prepare /data, then run the command as the unprivileged `node` user.
set -eu

# `docker cp` and bind mounts both bring in files the node user can't write. Only walk the tree
# when something is actually wrong, since .cache can be large.
if [ -n "$(find /data ! -user node -print -quit)" ]; then
  chown -R node:node /data
fi

# supercronic gives every job the CRON_TZ zone as TZ, so keep the container's own for the logs.
export CONTAINER_TZ="${TZ:-}"

exec setpriv --reuid=node --regid=node --init-groups "$@"
