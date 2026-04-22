#!/usr/bin/env bash
# Who's lobbying on a tech-policy bill? Demonstrates bill-watchers.
#
# Uses a free-text substring against LDA's specific-lobbying-issues field.
# Typical output: a ranked table of tech, telecom, and content-industry
# clients with their firms and spend.

set -e
cd "$(dirname "$0")/.."
bun run src/cli.ts bill-watchers --bill="Kids Online Safety Act" --year-start=2022 --year-end=2024
