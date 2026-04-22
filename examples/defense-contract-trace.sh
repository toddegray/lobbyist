#!/usr/bin/env bash
# LDA + USASpending.gov join. Demonstrates contract-trace.
#
# Given a defense prime, computes total LDA-reported lobbying spend vs.
# total federal contract awards in the same window, plus a derived
# (non-causal) ratio and the top awards.

set -e
cd "$(dirname "$0")/.."
bun run src/cli.ts contract-trace "Lockheed Martin" --year-start=2020 --year-end=2024
