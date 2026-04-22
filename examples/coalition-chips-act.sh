#!/usr/bin/env bash
# Entities lobbying together on a major bill. Demonstrates coalition-detect.
#
# Uses free-text matching against LDA's specific-issue field, then groups
# clients by shared registrant, shared quarters, and shared issue codes.
# Returns a ranked list of coalitions with a confidence score.

set -e
cd "$(dirname "$0")/.."
bun run src/cli.ts coalition-detect --bill="CHIPS Act" --year-start=2021 --year-end=2023 --min-size=3
