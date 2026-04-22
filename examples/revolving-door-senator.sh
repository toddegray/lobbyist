#!/usr/bin/env bash
# Career arc for an individual registered lobbyist. Demonstrates revolving-door.
#
# Surfaces: covered positions disclosed across filings, clients lobbied
# for with date ranges, employing firms. Does NOT interpret cooling-off
# compliance (that's a legal question for a human lawyer).

set -e
cd "$(dirname "$0")/.."
bun run src/cli.ts revolving-door "Heather Podesta" --year-start=2010 --year-end=2024
