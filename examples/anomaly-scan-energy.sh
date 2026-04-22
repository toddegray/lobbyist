#!/usr/bin/env bash
# Anomaly scan on an energy major. Demonstrates anomaly-scan.
#
# Looks for: late filings, new lobbyists, ex-staffer hires (via the
# covered_position field), issue-code churn between quarters, and new
# government entities contacted. Flags are suggestions, not accusations.

set -e
cd "$(dirname "$0")/.."
bun run src/cli.ts anomaly-scan "Exxon Mobil Corporation" --year-start=2020 --year-end=2024
