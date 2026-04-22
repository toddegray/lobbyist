/**
 * Shared helpers used by the ask orchestrator. Kept separate from ask.ts
 * because dynamic imports (for the filing-diff window parser) would
 * otherwise re-enter ask.ts's module graph.
 */

import type { TimeWindow } from "../core/types.ts";

export function parseWindow(raw: string, label: string): TimeWindow {
  const qMatch = raw.match(/^(\d{4})-Q([1-4])$/);
  if (qMatch) {
    const y = Number.parseInt(qMatch[1]!, 10);
    const q = Number.parseInt(qMatch[2]!, 10) as 1 | 2 | 3 | 4;
    return { year_start: y, year_end: y, quarter: q };
  }
  const rangeMatch = raw.match(/^(\d{4})-(\d{4})$/);
  if (rangeMatch) {
    return {
      year_start: Number.parseInt(rangeMatch[1]!, 10),
      year_end: Number.parseInt(rangeMatch[2]!, 10),
    };
  }
  const yearMatch = raw.match(/^(\d{4})$/);
  if (yearMatch) {
    const y = Number.parseInt(yearMatch[1]!, 10);
    return { year_start: y, year_end: y };
  }
  throw new Error(`${label}: expected YYYY, YYYY-Qn, or YYYY-YYYY (got "${raw}")`);
}
