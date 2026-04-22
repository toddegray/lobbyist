#!/usr/bin/env bash
# Full composed brief for a finance-sector client. Demonstrates brief composer.
#
# Runs entity-profile + spend-analysis + anomaly-scan (+ contract-trace if
# --with-contracts is set) and concatenates them into a single shareable
# markdown document.

set -e
cd "$(dirname "$0")/.."
bun run src/cli.ts brief "JPMorgan Chase & Co." --year-start=2020 --year-end=2024 --with-contracts
