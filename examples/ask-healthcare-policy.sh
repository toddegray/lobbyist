#!/usr/bin/env bash
# Natural-language question routed through the ask orchestrator.
# REQUIRES: ANTHROPIC_API_KEY (env) or anthropic_api_key (config).
#
# Claude picks the right skills (likely bill-watchers + committee-influence
# + entity-profile for the top clients) and composes a narrative answer.

set -e
cd "$(dirname "$0")/.."
bun run src/cli.ts ask \
  "Which drug-pricing lobbying clients gave the most to Senate Finance Committee members in the 2024 cycle?" \
  --stats
