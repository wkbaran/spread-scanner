#!/usr/bin/env bash
# Deploy infra/cloudformation.yaml, taking every parameter from .env.
#
# `aws cloudformation deploy` is destructive when you forget an argument: every
# parameter except BucketName defaults to empty or false, so a bare deploy against a
# live stack drops the custom domain and its certificate, and the basic-auth prompt.
# Put the values in .env once and run this; they are passed every time.
#
#   ./scripts/deploy-stack.sh                      # values from .env
#   ./scripts/deploy-stack.sh CustomDomain=x.com   # ...with one overridden
#   ./scripts/deploy-stack.sh --dry-run            # print what would be deployed, run nothing
#
# Precedence per value: command-line argument > exported environment variable > .env.
set -euo pipefail

APP_DIR="$(cd "$(dirname "$0")/.." && pwd)"
ENV_FILE="$APP_DIR/.env"
TEMPLATE="$APP_DIR/infra/cloudformation.yaml"

dry_run=0
declare -A OVERRIDE=()
for arg in "$@"; do
  case "$arg" in
    --dry-run) dry_run=1 ;;
    --help|-h) sed -n '2,12p' "$0" | sed 's/^# \?//'; exit 0 ;;
    *=*) OVERRIDE["${arg%%=*}"]="${arg#*=}" ;;
    *) echo "Unrecognized argument: $arg (expected Key=Value, --dry-run or --help)" >&2; exit 2 ;;
  esac
done

# One key out of .env. Not `source`: values may hold spaces and '#', and sourcing would run them.
env_file_value() {
  [ -f "$ENV_FILE" ] || return 0
  sed -n "s/^[[:space:]]*$1[[:space:]]*=[[:space:]]*//p" "$ENV_FILE" | head -n1 | sed -e 's/[[:space:]]*$//' -e 's/^"\(.*\)"$/\1/' -e "s/^'\(.*\)'$/\1/"
}

# resolve <ParameterName> <ENV_VAR_NAME> [default]
resolve() {
  local param="$1" var="$2" fallback="${3-}" value
  if [ -n "${OVERRIDE[$param]+set}" ]; then printf '%s' "${OVERRIDE[$param]}"; return; fi
  value="${!var-}"
  [ -n "$value" ] || value="$(env_file_value "$var")"
  printf '%s' "${value:-$fallback}"
}

STACK_NAME="$(resolve StackName STACK_NAME spread-scanner-site)"
REGION="$(resolve Region AWS_REGION us-east-1)"

declare -A PARAMS=(
  [BucketName]="$(resolve BucketName S3_BUCKET)"
  [EnableBasicAuth]="$(resolve EnableBasicAuth ENABLE_BASIC_AUTH false)"
  [BasicAuthUser]="$(resolve BasicAuthUser BASIC_AUTH_USER)"
  [BasicAuthPassword]="$(resolve BasicAuthPassword BASIC_AUTH_PASSWORD)"
  [CustomDomain]="$(resolve CustomDomain CUSTOM_DOMAIN)"
  [HostedZoneId]="$(resolve HostedZoneId HOSTED_ZONE_ID)"
  [EnableTickets]="$(resolve EnableTickets ENABLE_TICKETS false)"
  [TicketToken]="$(resolve TicketToken TICKET_TOKEN)"
)

if [ -z "${PARAMS[BucketName]}" ]; then
  echo "BucketName is required. Set S3_BUCKET in .env, or pass BucketName=..." >&2
  exit 2
fi
if [ -n "${PARAMS[CustomDomain]}" ] && [ -z "${PARAMS[HostedZoneId]}" ]; then
  echo "CustomDomain needs HostedZoneId (the PUBLIC Route 53 zone). Set HOSTED_ZONE_ID in .env." >&2
  exit 2
fi
if [ "${PARAMS[EnableBasicAuth]}" = "true" ] && { [ -z "${PARAMS[BasicAuthUser]}" ] || [ "${#PARAMS[BasicAuthPassword]}" -lt 12 ]; }; then
  echo "EnableBasicAuth needs BASIC_AUTH_USER and a BASIC_AUTH_PASSWORD of 12+ characters." >&2
  exit 2
fi

if [ "${PARAMS[EnableTickets]}" = "true" ] && [ "${#PARAMS[TicketToken]}" -lt 32 ]; then
  echo "EnableTickets needs a TICKET_TOKEN of 32+ random characters (openssl rand -hex 32)." >&2
  exit 2
fi

# Refuse to blank a parameter the deployed stack currently has set. "****" is how a NoEcho
# parameter reads back, so its real value can only come from .env. tr -d '\r' for the AWS
# CLI on Windows, which emits CRLF.
existing="$(aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Parameters[].[ParameterKey,ParameterValue]' --output text 2>/dev/null | tr -d '\r' || true)"
if [ -n "$existing" ]; then
  clearing=()
  while IFS=$'\t' read -r key value; do
    [ -n "$key" ] || continue
    case "$value" in ""|"false"|"****") continue ;; esac
    [ -n "${PARAMS[$key]+set}" ] || continue
    resolved="${PARAMS[$key]}"
    if [ -z "$resolved" ] || { [ "$value" = "true" ] && [ "$resolved" = "false" ]; }; then
      clearing+=("$key")
    fi
  done <<< "$existing"
  if [ ${#clearing[@]} -gt 0 ]; then
    echo "Refusing to deploy: these are set on the live stack and this deploy would clear them:" >&2
    printf '  %s\n' "${clearing[@]}" >&2
    echo "Set them in .env, or pass Key=Value to deploy anyway." >&2
    exit 1
  fi
fi

overrides=()
for key in "${!PARAMS[@]}"; do overrides+=("$key=${PARAMS[$key]}"); done

printf 'Deploying %s to %s:\n' "$STACK_NAME" "$REGION"
for key in $(printf '%s\n' "${!PARAMS[@]}" | sort); do
  case "$key" in
    BasicAuthPassword|TicketToken) printf '  %-18s %s\n' "$key" "$([ -n "${PARAMS[$key]}" ] && echo '(set)' || echo '(empty)')" ;;
    *) printf '  %-18s %s\n' "$key" "${PARAMS[$key]:-(empty)}" ;;
  esac
done

if [ "$dry_run" -eq 1 ]; then
  echo "(--dry-run: nothing was deployed)"
  exit 0
fi

aws cloudformation deploy \
  --region "$REGION" \
  --stack-name "$STACK_NAME" \
  --template-file "$TEMPLATE" \
  --capabilities CAPABILITY_NAMED_IAM \
  --parameter-overrides "${overrides[@]}"

aws cloudformation describe-stacks --region "$REGION" --stack-name "$STACK_NAME" \
  --query 'Stacks[0].Outputs' --output table
