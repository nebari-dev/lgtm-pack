#!/usr/bin/env bash
# Template-rendering assertions for both Mimir modes (monolithic default,
# distributed opt-in). Pure `helm template` — no cluster required.
# Prerequisite: helm dependency update chart
set -euo pipefail

CHART="$(cd "$(dirname "$0")/.." && pwd)"

fail() { echo "ASSERT FAIL: $1" >&2; exit 1; }

# assert_contains <var-name> <pattern> <message>
assert_contains() {
  if ! grep -q -- "$2" <<<"${!1}"; then fail "$3"; fi
}

# assert_not_contains <var-name> <pattern> <message>
assert_not_contains() {
  if grep -q -- "$2" <<<"${!1}"; then fail "$3"; fi
}

echo "== rendering default (monolithic) mode =="
DEFAULT_OUT="$(helm template test "$CHART" --namespace default --set nebariapp.enabled=false)"

echo "== rendering distributed mode =="
DIST_OUT="$(helm template test "$CHART" --namespace default --set nebariapp.enabled=false \
  --set mimir-distributed.enabled=true)"

# --- Mode toggle: exactly one Mimir topology renders per mode ---
assert_not_contains DEFAULT_OUT 'name: test-mimir-ingester' \
  "default mode must not render mimir-distributed components"
assert_contains DIST_OUT 'name: test-mimir-ingester' \
  "distributed mode must render mimir-distributed components"
assert_contains DIST_OUT 'name: test-mimir-gateway' \
  "distributed mode must render the mimir gateway"

echo "All rendering assertions passed."
