#!/usr/bin/env bash
# How did Amazon's lobbying change? Demonstrates filing-diff.
#
# Compares two windows side by side and surfaces: added/dropped
# lobbyists, added/dropped issue codes, firms hired or dropped, new
# government entities contacted, and the spend delta.

set -e
cd "$(dirname "$0")/.."
bun run src/cli.ts filing-diff "Amazon.com Services LLC" --from=2020 --to=2024
