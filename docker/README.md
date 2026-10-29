# Running spread-scanner on a Docker host

One container runs `docker/run-scan.sh` on weekdays at 7:40, 9:30, 11:30 and 13:20 Mountain time: scan the
whole optionable market (or a watchlist, if you leave one), save the ranked result, rebuild the report and publish it to S3 behind CloudFront. The
saved runs are the log that `validate` needs, so leaving this running is what makes the ranking
checkable.

The scheduler is [supercronic](https://github.com/aptible/supercronic) reading `docker/crontab`.
Nothing runs at container start; the first scan is the next one on that list.

Run everything below from the repo root. There is no build step and no `npm install`: Node 26 runs
the TypeScript directly.

## Where things live

There are no named volumes. Everything the container reads or writes is a bind mount of one
directory on the Docker host, `STATE_DIR`, at `/data`:

```
$STATE_DIR/
  config/local.json    your thresholds, merged over config/default.json (you supply it)
  watchlist.txt        optional: one symbol per line, scanned instead of the whole market
  runs/                one saved scan per run: the log `validate` reads. Back it up.
  report/              the last built page
  .cache/              chain listings and earnings windows
```

Set it in `docker/.env` (gitignored; compose reads it on the machine running `docker compose`). It
has no default on purpose: an unset one would mount an empty directory.

```sh
cp docker/.env.example docker/.env      # then set STATE_DIR to an absolute path on the Docker host
```

If spread-book runs on the same host, set `SPREAD_BOOK_REPORTS` in `docker/.env` to its `reports/` directory.
It is mounted read-only at `/spread-book`, and each report reads the `latest.json` there (`SPREAD_BOOK_BRIEF`)
to mark the spreads you hold. Without it the report marks none and says so in the log.

## Time zones

Everything a person reads is in one zone, Mountain, the same as equity-watch's container: the schedule in
`docker/crontab`, the container's logs and `date` (`TZ` in the Dockerfile), and the scan time on the
report (`display.timeZone` in the config). Mixing zones across services gets confusing fast, so if you move,
change all three together. Market logic (what "today" is for the earnings rule) is New York's date
regardless. Dates on the report (expirations, earnings) have no time or zone.

## 1. Create the site

The stack is `infra/cloudformation.yaml`: a private S3 bucket, a CloudFront distribution with an
ACM certificate, a Route 53 alias, an optional basic-auth prompt, and an IAM user that can only
`PutObject` the report's own four files. It deploys in us-east-1.

```sh
cp .env.example .env     # the stack's settings: S3_BUCKET, CUSTOM_DOMAIN, HOSTED_ZONE_ID (the PUBLIC zone) ...
./scripts/deploy-stack.sh --dry-run
./scripts/deploy-stack.sh
```

Use the script rather than `aws cloudformation deploy`: every parameter except the bucket name
defaults to empty, so a bare deploy against a live stack would drop the custom domain and its
certificate. The script passes all of them every time and refuses a deploy that would blank one the
stack has set.

The publisher's key is not an output: anyone who can describe a stack can read its outputs. It is in
Secrets Manager as `spread-scanner/<bucket>/publisher` (the `PublishKeySecret` output), already named
for the container's env file:

```sh
cp docker/scanner.env.example docker/scanner.env    # tastytrade, FMP, the bucket and region
aws secretsmanager get-secret-value --secret-id spread-scanner/<bucket>/publisher \
  --query SecretString --output text                # AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY
```

`.env` (the stack) and `docker/scanner.env` (the container) are separate so the container never holds
the basic-auth password or the ticket token. Certificate validation takes a few minutes on the first
deploy.

Every response carries AWS's managed security headers (HSTS, `X-Frame-Options: SAMEORIGIN`, `nosniff`,
a strict-origin referrer), so no other site can frame the page.

`ENABLE_BASIC_AUTH=true` (with `BASIC_AUTH_USER` and a 12+ character `BASIC_AUTH_PASSWORD`) puts a
password prompt in front of the site. The page embeds the scan, and the scan carries the thresholds
it ran with, so turn it on if you would rather not publish those.

### Paper trades (optional)

`ENABLE_TICKETS=true` with a `TICKET_TOKEN` (`openssl rand -hex 32`) adds the page's **Paper trade**
button's back end to the stack: `/api/tickets` on the same CloudFront (a Lambda that checks the token
and the ticket's shape), an SQS FIFO queue, and a second IAM user for spread-book's ticket watcher,
which can only receive and delete tickets and write their results to `tickets/` in the bucket. The
page polls `tickets/<id>.json`, which is never cached and sits behind the same basic auth as the page.

After the deploy, copy the output `TicketQueueUrl` into spread-book's `docker/.env` as
`TICKETS_QUEUE_URL`, with `TICKETS_BUCKET` set to this bucket, and the watcher's key from Secrets
Manager (`aws secretsmanager get-secret-value --secret-id spread-scanner/<bucket>/ticket-watcher`,
the `TicketWatcherKeySecret` output), which holds `TICKETS_AWS_ACCESS_KEY_ID` and
`TICKETS_AWS_SECRET_ACCESS_KEY`. Then set `"display": { "tickets": true }` in
`config/local.json`; from the next scan the rail has a **Paper trades** section, where you paste the
token once per browser. Without a saved token the page has no button that acts.

## 2. Start the container

```sh
# against a remote host, compose runs here and talks to the host's Docker over ssh:
export DOCKER_HOST=ssh://user@docker-host
ssh user@docker-host 'mkdir -p ~/spread-scanner/config'
# put config/local.json in that directory, owned by uid 1000 (the container's `node` user)

docker compose -f docker/docker-compose.yaml up -d --build
docker compose -f docker/docker-compose.yaml logs -f
```

`docker/scanner.env` is read at run time and is not copied into the image (`.dockerignore` keeps every
env file and the state out of the build context, which matters when the build runs on a remote host).

The container drops every Linux capability except the four its entrypoint needs to fix `/data`'s
ownership and switch to the `node` user, which then runs with none (`no-new-privileges` keeps it that
way). The base image is pinned by digest; the Dockerfile says how to bump it for security updates.

Try a run without waiting for the schedule:

```sh
docker compose -f docker/docker-compose.yaml exec -u node spread-scanner /app/docker/run-scan.sh
```

## Day to day

```sh
docker compose -f docker/docker-compose.yaml run --rm cli validate     # once runs are weeks old
docker compose -f docker/docker-compose.yaml run --rm cli scan --symbols SPY,QQQ
```

To change the schedule, edit `docker/crontab` and rebuild. To change the thresholds or the funnel,
edit `config/local.json` in `STATE_DIR`; the next run reads it.

## What can go wrong

- **A leftover watchlist.txt:** if one is in the state directory the run scans only that and says so in its first lines. Delete it to go back to scanning the whole market.
- **The publish fails:** the scan and the report are already saved; the run exits 1 and the page
  keeps showing the last published one. A 403 usually means a missing or old key in `docker/scanner.env`, or a
  new file in `report/` that `PublishUser` in the stack does not list (it may write only the report's
  own files).
- **Market holidays:** there is no holiday calendar, so a scan runs against the last session's
  quotes and is saved as a run that repeats the day before. `validate` counts a spread once at its
  first listing, so this does no harm to it, but the published page will carry that day's stamp.
- **Paper trade says spread-book hasn't answered:** the ticket is queued but nothing took it. Look at
  spread-book's `spread-book-tickets` service (its logs, and its health check, which reads the
  watcher's heartbeat). A ticket left on the queue is rejected as stale once spread-book does take it,
  so send it again rather than wait.
- **Paper trade says "The token was refused":** the page forgot the token; save it again under
  Paper trades. The token is `TICKET_TOKEN` in `.env`, and changing it needs a stack deploy.
- **Health:** the container is "healthy" while the scheduler is alive. A failed scan exits non-zero
  and, with `HEALTHCHECK_URL` in `.env`, pings `<url>/fail`.
