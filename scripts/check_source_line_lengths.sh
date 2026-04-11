#!/usr/bin/env bash
set -euo pipefail

limit=500
status=0

while IFS= read -r file; do
  case "$file" in
    *.rs|*.js|*.mjs|*.cjs|*.ts|*.tsx|*.jsx|*.css|*.scss|*.html|*.py|*.sh|*.sql)
      ;;
    *)
      continue
      ;;
  esac

  if [[ ! -f "$file" ]]; then
    continue
  fi

  lines="$(wc -l < "$file")"
  lines="${lines//[[:space:]]/}"

  if (( lines > limit )); then
    printf 'error: %s has %s lines; limit is %s\n' "$file" "$lines" "$limit" >&2
    status=1
  fi
done < <(git ls-files --cached --others --exclude-standard)

if (( status != 0 )); then
  cat >&2 <<'EOF'

Split large source files into smaller modules before committing.
EOF
  exit 1
fi
