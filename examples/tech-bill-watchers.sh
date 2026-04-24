#!/usr/bin/env bash
# Who's lobbying on a tech-policy bill? Demonstrates bill-watchers.
#
# Two modes shown:
#   1. --congress-bill=CONGRESS/TYPE/NUMBER — exact Congress.gov reference.
#      Enriches the output with the bill's official title, sponsor,
#      introduction date, latest action, and committees of jurisdiction.
#      Uses the official title as the LDA substring for broader coverage.
#   2. --bill="<substring>" — free-text match against LDA filings' own
#      specific-issue field. No Congress.gov call.

set -e
cd "$(dirname "$0")/.."

echo "=== CHIPS and Science Act (117th Congress, H.R. 4346) ==="
bun run src/cli.ts bill-watchers \
  --congress-bill=117/HR/4346 \
  --year-start=2021 --year-end=2023

echo ""
echo "=== Kids Online Safety Act (free-text fallback) ==="
bun run src/cli.ts bill-watchers \
  --bill="Kids Online Safety Act" \
  --year-start=2022 --year-end=2024
