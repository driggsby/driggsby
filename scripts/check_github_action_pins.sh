#!/usr/bin/env bash
set -euo pipefail

status=0
allowed_prefixes=(
  "actions/cache@"
  "actions/checkout@"
  "actions/dependency-review-action@"
  "actions/download-artifact@"
  "actions/setup-go@"
  "actions/setup-node@"
  "actions/upload-artifact@"
  "github/codeql-action/"
)

while IFS= read -r line; do
  file=${line%%:*}
  rest=${line#*:}
  lineno=${rest%%:*}
  content=${rest#*:}

  value=$(printf '%s\n' "$content" \
    | sed -E 's/^[[:space:]]*uses:[[:space:]]*//; s/[[:space:]]+#.*$//')

  if [[ "$value" == ./* || "$value" == docker://* ]]; then
    continue
  fi

  if [[ ! "$value" =~ ^[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+(/[A-Za-z0-9_.-]+)*@[0-9a-f]{40}$ ]]; then
    echo "Unpinned or unsupported GitHub Action reference at ${file}:${lineno}: ${value}" >&2
    status=1
    continue
  fi

  allowed=0
  for prefix in "${allowed_prefixes[@]}"; do
    if [[ "$value" == "$prefix"* ]]; then
      allowed=1
      break
    fi
  done

  if [[ "$allowed" -eq 0 ]]; then
    echo "Unapproved GitHub Action source at ${file}:${lineno}: ${value}" >&2
    status=1
  fi
done < <(rg -n '^[[:space:]]*uses:[[:space:]]*' .github/workflows/*.yml)

exit "$status"
