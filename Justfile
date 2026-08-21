required-check:
    #!/usr/bin/env bash
    set -euo pipefail
    npm ci
    npm run check
    npm run build
    bash scripts/check_source_line_lengths.sh

verify: required-check
    npm test

check-npm-package:
    node scripts/release/check-npm-publish-surface.ts
