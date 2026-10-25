# spread-scanner: the scheduled scan, report build and publish, for a Docker host.
#
# Build context is the repo root (docker-compose.yaml sets it):
#   docker build -f docker/Dockerfile -t spread-scanner .
#
# There is no build stage and no `npm install`: Node 26 runs the TypeScript directly and the
# project has no runtime dependencies.
#
# Two directories, on purpose:
#   /app   the code: src/, web/, config/default.json. Replaced by every rebuild.
#   /data  everything the scanner writes or the owner supplies: watchlist.txt, config/local.json,
#          runs/ (the log `validate` needs), report/, .cache/. This is the volume.

# Pinned by digest, so a rebuild is the image that was tested and not whatever the tag points at today.
# To take the base image's security updates, bump it:
#   docker buildx imagetools inspect node:26-bookworm-slim   (the Digest line)
FROM node:26-bookworm-slim@sha256:28147155d47dc31abe0a46e0d12b59b2fb3d0a2dcc5dc65fce76a074180b16fe
# tzdata so TZ is honoured by the schedule and the logs; curl for the healthcheck ping and for
# fetching supercronic below.
RUN apt-get update \
 && apt-get install -y --no-install-recommends ca-certificates curl tzdata \
 && rm -rf /var/lib/apt/lists/*

# The scheduler: supercronic runs docker/crontab in the foreground, logs each job's output to the
# container log, and skips a tick while the last run is still going. Pinned per architecture with
# the release's published sha256 (bump both together).
ARG TARGETARCH
ARG SUPERCRONIC_VERSION=v0.2.49
ARG SUPERCRONIC_SHA256_AMD64=a53ae236602c7338aba3fbaff40bda6300eae3b9fedb8261eb06cfe3724430c1
ARG SUPERCRONIC_SHA256_ARM64=02aa0cb229ba09050cba6638059dadb9eedc2276632ea43d6a57a2f8c1629dd5
RUN case "$TARGETARCH" in \
      amd64) sha="$SUPERCRONIC_SHA256_AMD64" ;; \
      arm64) sha="$SUPERCRONIC_SHA256_ARM64" ;; \
      *) echo "no supercronic checksum for $TARGETARCH" >&2; exit 1 ;; \
    esac \
 && curl -fsSL -o /usr/local/bin/supercronic \
      "https://github.com/aptible/supercronic/releases/download/${SUPERCRONIC_VERSION}/supercronic-linux-${TARGETARCH}" \
 && echo "${sha}  /usr/local/bin/supercronic" | sha256sum -c - \
 && chmod +x /usr/local/bin/supercronic

WORKDIR /app
COPY package.json ./
COPY src ./src
COPY web ./web
COPY config/default.json ./config/default.json
COPY docker/entrypoint.sh docker/run-scan.sh docker/healthcheck.sh docker/crontab ./docker/
# A Windows checkout can hand these over with CRLF endings, which Linux reads as "bad interpreter".
# .gitattributes prevents it; this makes the build immune anyway.
RUN sed -i 's/\r$//' docker/*.sh docker/crontab \
 && chmod +x docker/*.sh \
 && printf '#!/bin/sh\nexec node /app/src/cli.ts "$@"\n' > /usr/local/bin/spread-scanner \
 && chmod +x /usr/local/bin/spread-scanner \
 && mkdir /data \
 && chown node:node /data

# One time zone for the schedule, the logs and the report, the same as equity-watch's container, so no
# service shows a time in a zone the next one does not. Change it here and in config's display.timeZone.
ENV HOME=/data \
    SPREAD_SCANNER_STATE_DIR=/data \
    TZ=America/Denver \
    NODE_ENV=production
WORKDIR /data
VOLUME /data

# Starts as root only to fix ownership of /data (files put there with `docker cp` arrive
# root-owned), then drops to the unprivileged `node` user.
ENTRYPOINT ["/app/docker/entrypoint.sh"]
CMD ["supercronic", "/app/docker/crontab"]

HEALTHCHECK --interval=5m --timeout=10s --start-period=20m --retries=1 \
  CMD ["/app/docker/healthcheck.sh"]
