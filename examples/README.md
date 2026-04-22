# Examples

This directory holds reproducible example invocations. Rather than checking
in static markdown briefs that would go stale the next time the LDA
amends a filing, each `.sh` file is a shell recipe that produces a fresh
brief against live public data.

Every brief you generate cites the underlying Senate LDA, FEC, or
USASpending.gov record. Re-run the recipe any time to refresh.

## Prerequisites

```bash
bun run src/cli.ts init           # configure LDA (required) + OpenFEC (for LDA+FEC) keys
```

## Recipes

| File | What it demonstrates |
| ---- | -------------------- |
| [big-pharma-profile.sh](big-pharma-profile.sh) | Full lobbying profile for a Big-Pharma client. Quarterly spend, lobbyists, issues, committees. |
| [tech-bill-watchers.sh](tech-bill-watchers.sh) | Who's lobbying on a specific tech-policy bill. |
| [defense-contract-trace.sh](defense-contract-trace.sh) | LDA+USASpending join: a defense contractor's lobbying spend vs. federal contract awards. |
| [committee-influence-healthcare.sh](committee-influence-healthcare.sh) | LDA+FEC join: top healthcare lobbying clients × contributions to a Senate HELP Committee member. Requires OpenFEC key. |
| [revolving-door-senator.sh](revolving-door-senator.sh) | Career arc for a named former staffer. |
| [coalition-chips-act.sh](coalition-chips-act.sh) | Entities lobbying together on the CHIPS Act via shared firms. |
| [filing-diff-amazon.sh](filing-diff-amazon.sh) | How Amazon's lobbying changed between 2020 and 2024. |
| [anomaly-scan-energy.sh](anomaly-scan-energy.sh) | Late filings, new lobbyists, ex-staffer hires, and issue churn for an energy major. |
| [full-brief-finance.sh](full-brief-finance.sh) | Composed brief (profile + spend + anomaly + contracts) for a finance-sector client. |
| [ask-healthcare-policy.sh](ask-healthcare-policy.sh) | Natural-language question routed through `lobbyist ask` to multiple skills. |

Each recipe runs in ~30 seconds on a cold cache, <5 seconds on a warm cache.
