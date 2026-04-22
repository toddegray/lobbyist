# Security posture

lobbyist is a local-first, public-data tool. It has minimal security surface
by construction, but the areas below are worth knowing about.

## Threat model

### In scope
- **API key handling.** LDA, OpenFEC, Congress.gov, and Anthropic keys are
  stored in `~/.lobbyist/config.json`, owner-readable. The `lobbyist config`
  command masks keys by default; `--reveal` is an explicit opt-in.
- **Network traffic.** All four data-source clients go over HTTPS.
- **Local database.** `~/.lobbyist/data/lobbyist.db` holds mirrored LDA
  filings + user annotations. Public data — no secrets in the DB.
- **Cache files.** `~/.lobbyist/cache/` holds verbatim API responses (no
  keys) so repeated runs don't burn rate limits.

### Out of scope
- **Protecting public lobbying filings.** All data is public; disclosure
  is built into the product.
- **Defending against malicious LDA responses.** zod validates payloads,
  but this is best-effort; a motivated attacker controlling the LDA API
  could in theory slip crafted responses through. This is equivalent to
  trusting the underlying source.
- **Air-gapped operation.** Not a goal; the tool requires network access
  to fetch filings. Cached runs work offline, but cold starts don't.

## API key handling

- Keys are loaded from env vars FIRST, then config file. Env wins.
- `lobbyist config` masks keys by default (`abcd…wxyz`). `--reveal` is
  opt-in for piping.
- Keys are never written to logs, stderr, or the SQLite database.
- On a 4xx from a data source, error messages redact the key in the URL
  (the OpenFecClient replaces `api_key=…` with `api_key=<redacted>`).
- The `feedback_never_handle_pasted_secrets` memory rule applies: if a
  user pastes a key in chat, the assistant refuses to use it and advises
  rotation.

## Local data posture

- `~/.lobbyist/` is owner-readable only (standard home-dir permissions).
- SQLite file at `~/.lobbyist/data/lobbyist.db` contains **public data
  only** — LDA filings, derived briefs, user notes. No PII beyond what
  filers disclose on government websites.
- Cache files at `~/.lobbyist/cache/*/` are plain-JSON dumps of API
  responses. Also public data. Safe to rm -rf to reset.
- **Telemetry: none.** No phone-home, no usage pings, no remote config.

## Cloud inference (opt-in)

- The `ask` orchestrator sends the user's question + tool results to the
  Anthropic Messages API. This is the only path where data leaves the
  user's machine beyond the raw API fetches.
- Tool results contain public LDA / FEC / USASpending data + the derived
  analysis. Nothing user-private.
- If you'd rather not send queries to Anthropic, skip `ask` and use the
  deterministic skills directly. Everything else is local.

## Disclosure guardrails

Since the whole product is about surfacing money in politics, there's no
scenario where we reveal private information. That said:

- **Annotations** stored in `~/.lobbyist/data/` are the user's own notes —
  don't commit the DB to a shared repo if your notes are sensitive. The
  `.gitignore` excludes `.lobbyist/` by default.
- **Digests** written by `lobbyist watch` land in
  `~/.lobbyist/digests/YYYY-MM-DD.md`. These reference public entities
  but can accumulate a pattern of interest (which companies a user is
  tracking). Treat as slightly more sensitive than the raw data.

## Reporting issues

If you find a security issue, email the maintainer (contact in the repo
README) with a clear reproducer. Please do not file it as a public GitHub
issue before we have a chance to address it.
