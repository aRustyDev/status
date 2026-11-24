#!/usr/bin/env bash
# Retry only the registry and npm CLI failures observed in CI. A successful
# attempt must still run npm's complete signature and attestation verification.
set -uo pipefail

log=$(mktemp)
trap 'rm -f "$log"' EXIT

for attempt in 1 2 3; do
  NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require ./scripts/attestation-recovery/preload.cjs" \
    npm audit signatures >"$log" 2>&1
  status=$?
  cat "$log"
  if [ "$status" -eq 0 ]; then
    exit 0
  fi

  # Never retry an explicit signature or attestation verification failure,
  # even when npm also reports a transient-looking error in the same output.
  if grep -Eqi 'EINTEGRITYSIGNATURE|EATTESTATIONVERIFY|invalid (registry )?signatures?|invalid attestations?|missing (registry )?signatures?' "$log"; then
    exit "$status"
  fi

  retryable=false
  if grep -Fq 'Exit handler never called!' "$log"; then
    retryable=true
  elif grep -Fq 'invalid json response body at https://registry.npmjs.org/-/npm/v1/attestations/' "$log" \
    && grep -Fq 'Unexpected token '\''O'\'', "OK' "$log"; then
    retryable=true
  fi
  if [ "$retryable" != true ] || [ "$attempt" -eq 3 ]; then
    exit "$status"
  fi
  echo "Signature audit failed with a known npm/registry error; retrying (attempt $((attempt + 1))/3)." >&2
  sleep "$((attempt * 2))"
done
