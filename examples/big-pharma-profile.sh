#!/usr/bin/env bash
# Big-Pharma lobbying profile — demonstrates entity-profile.
#
# Pfizer Inc has been an LDA registrant since 1999. Running this against
# 2020–2024 typically shows $10M+ in quarterly spend, 40+ lobbyists, and
# activity across HCR (Health), TRD (Trade), and MMM (Medicare/Medicaid).

set -e
cd "$(dirname "$0")/.."
bun run src/cli.ts entity-profile "Pfizer Inc" --year-start=2020 --year-end=2024
