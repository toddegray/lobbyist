#!/usr/bin/env bash
# LDA + FEC join. Demonstrates committee-influence.
# REQUIRES: LOBBYIST_OPENFEC_API_KEY (or openfec_api_key in config).
#
# Takes a member of Congress + LDA issue codes of jurisdiction for their
# committee, ranks the top lobbying clients on those issues, then looks
# up FEC ScheduleA receipts from each client's employees to the member's
# principal campaign committee.

set -e
cd "$(dirname "$0")/.."
bun run src/cli.ts committee-influence \
  --member="Bernie Sanders" \
  --issue-codes=HCR,MMM \
  --year-start=2022 --year-end=2024 \
  --cycle=2024
