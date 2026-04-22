/**
 * `lobbyist init` — first-run setup.
 *
 * Two modes:
 *  - interactive (default, when stdin is a TTY): prompts for each field,
 *    including walking the user through the Senate LDA key signup.
 *  - non-interactive (--non-interactive or not-a-TTY): values come from flags.
 *
 * Writes ~/.lobbyist/config.json (or $LOBBYIST_CONFIG_PATH).
 *
 * The LDA API key comes from lda.senate.gov/api/register/. Signup is free,
 * instant, and email-only. The token is shown once on the confirmation page
 * and can be regenerated later.
 *
 * OpenFEC key (optional at v0.1, required for v0.5 cross-reference skills)
 * comes from api.open.fec.gov/developers/.
 */

import { createInterface } from "node:readline/promises";
import { stdin, stdout } from "node:process";
import {
  buildConfig,
  configPath,
  readConfigFile,
  writeConfigFile,
} from "../core/config.ts";

const LDA_SIGNUP_URL = "https://lda.senate.gov/api/register/";
const OPENFEC_SIGNUP_URL = "https://api.open.fec.gov/developers/";

interface Flags {
  force: boolean;
  nonInteractive: boolean;
  name: string | undefined;
  email: string | undefined;
  ldaKey: string | undefined;
  openfecKey: string | undefined;
  anthropicKey: string | undefined;
  watchlist: string | undefined;
  yearStart: string | undefined;
  yearEnd: string | undefined;
}

function parseFlags(args: string[]): Flags {
  const getVal = (key: string): string | undefined => {
    const hit = args.find((a) => a.startsWith(`--${key}=`));
    return hit ? hit.slice(`--${key}=`.length) : undefined;
  };
  return {
    force: args.includes("--force"),
    nonInteractive: args.includes("--non-interactive") || !stdin.isTTY,
    name: getVal("name"),
    email: getVal("email"),
    ldaKey: getVal("lda-key") ?? getVal("api-key"),
    openfecKey: getVal("openfec-key"),
    anthropicKey: getVal("anthropic-key"),
    watchlist: getVal("watchlist"),
    yearStart: getVal("year-start"),
    yearEnd: getVal("year-end"),
  };
}

function parseYear(input: string, label: string): number {
  const n = Number.parseInt(input, 10);
  if (!Number.isFinite(n) || n < 1999 || n > 2100) {
    throw new Error(`invalid ${label}: ${input}`);
  }
  return n;
}

function maskKey(key: string): string {
  if (key.length <= 8) return "***";
  return `${key.slice(0, 4)}…${key.slice(-4)}`;
}

export async function runInit(args: string[]): Promise<number> {
  const flags = parseFlags(args);
  const path = configPath();

  const existing = await readConfigFile(path).catch(() => null);
  if (existing && !flags.force) {
    console.log(`lobbyist is already configured at ${path}.`);
    console.log(`  operator:       ${existing.operator.name} <${existing.operator.email}>`);
    console.log(`  lda_api_key:    ${maskKey(existing.lda_api_key)}`);
    console.log(
      `  openfec_api_key: ${existing.openfec_api_key ? maskKey(existing.openfec_api_key) : "(unset — LDA+FEC cross-ref skills disabled)"}`,
    );
    console.log(`  year range:     ${existing.default_year_start}–${existing.default_year_end}`);
    if (existing.watchlist.length) {
      console.log(`  watchlist:     ${existing.watchlist.join(", ")}`);
    }
    console.log("");
    console.log("Re-run with --force to overwrite.");
    return 0;
  }

  let operator_name = flags.name || existing?.operator.name;
  let operator_email = flags.email || existing?.operator.email;
  let lda_api_key = flags.ldaKey || existing?.lda_api_key;
  let openfec_api_key = flags.openfecKey ?? existing?.openfec_api_key ?? null;
  let anthropic_api_key = flags.anthropicKey ?? existing?.anthropic_api_key ?? null;
  let watchlist_in = flags.watchlist ?? (existing?.watchlist ?? []).join(",");
  let year_start_in = flags.yearStart ?? String(existing?.default_year_start ?? 2020);
  let year_end_in = flags.yearEnd ?? String(existing?.default_year_end ?? 2024);

  if (flags.nonInteractive) {
    if (!operator_name || !operator_email || !lda_api_key) {
      console.error("init (non-interactive) requires --name, --email, and --lda-key.");
      console.error('example: lobbyist init --non-interactive --name="Todd Gray" \\');
      console.error('  --email="you@example.com" --lda-key="$LOBBYIST_LDA_API_KEY"');
      return 2;
    }
  } else {
    const rl = createInterface({ input: stdin, output: stdout });
    const ask = async (prompt: string, fallback?: string): Promise<string> => {
      const suffix = fallback ? ` [${fallback}]` : "";
      const answer = (await rl.question(`${prompt}${suffix}: `)).trim();
      return answer || fallback || "";
    };

    console.log("lobbyist setup — this takes about a minute.");
    console.log("");
    console.log("You'll need a Senate LDA API key. Free, instant, email-only.");
    console.log(`  1. Open ${LDA_SIGNUP_URL}`);
    console.log("  2. Fill in name + email. The token appears on the confirmation");
    console.log("     page and is also emailed to you.");
    console.log("  3. Paste it here.");
    console.log("");
    console.log("Optional: an OpenFEC key unlocks LDA+FEC cross-reference skills in v0.5.");
    console.log(`  Sign up at ${OPENFEC_SIGNUP_URL} — paste below when prompted.`);
    console.log("");

    operator_name = await ask("Your name", operator_name);
    operator_email = await ask("Your contact email", operator_email);
    lda_api_key = await ask(
      "Senate LDA API key",
      lda_api_key ? maskKey(lda_api_key) : undefined,
    );
    if (existing?.lda_api_key && lda_api_key === maskKey(existing.lda_api_key)) {
      lda_api_key = existing.lda_api_key;
    }

    const openfec_in = await ask(
      "OpenFEC API key (optional, enables v0.5 cross-reference skills)",
      openfec_api_key ? maskKey(openfec_api_key) : "",
    );
    if (openfec_api_key && openfec_in === maskKey(openfec_api_key)) {
      // keep existing
    } else {
      openfec_api_key = openfec_in || null;
    }

    const anthropic_in = await ask(
      "Anthropic API key (optional, enables narrative briefs)",
      anthropic_api_key ? maskKey(anthropic_api_key) : "",
    );
    if (anthropic_api_key && anthropic_in === maskKey(anthropic_api_key)) {
      // keep existing
    } else {
      anthropic_api_key = anthropic_in || null;
    }

    year_start_in = await ask("Default year range START", year_start_in);
    year_end_in = await ask("Default year range END", year_end_in);
    watchlist_in = await ask(
      "Watchlist (optional, comma-separated entity IDs or names)",
      watchlist_in,
    );
    rl.close();
  }

  if (!operator_name || !operator_email || !lda_api_key) {
    console.error("error: name, email, and LDA API key are all required.");
    return 2;
  }

  let default_year_start: number;
  let default_year_end: number;
  try {
    default_year_start = parseYear(year_start_in, "year-start");
    default_year_end = parseYear(year_end_in, "year-end");
    if (default_year_end < default_year_start) {
      throw new Error("year-end must be >= year-start");
    }
  } catch (e) {
    console.error(`error: ${e instanceof Error ? e.message : String(e)}`);
    return 2;
  }

  const config = buildConfig({
    operator_name,
    operator_email,
    lda_api_key,
    openfec_api_key,
    anthropic_api_key,
    default_year_start,
    default_year_end,
    watchlist: watchlist_in
      ? watchlist_in.split(",").map((s) => s.trim()).filter(Boolean)
      : [],
  });

  await writeConfigFile(config, path);
  console.log("");
  console.log(`wrote ${path}`);
  console.log(`  operator:       ${config.operator.name} <${config.operator.email}>`);
  console.log(`  lda_api_key:    ${maskKey(config.lda_api_key)}`);
  console.log(
    `  openfec_api_key: ${config.openfec_api_key ? maskKey(config.openfec_api_key) : "(unset)"}`,
  );
  console.log(`  year range:     ${config.default_year_start}–${config.default_year_end}`);
  if (config.watchlist.length) {
    console.log(`  watchlist:     ${config.watchlist.join(", ")}`);
  }
  console.log("");
  console.log("Next: try `lobbyist ping` to sanity-check your LDA key.");
  return 0;
}
