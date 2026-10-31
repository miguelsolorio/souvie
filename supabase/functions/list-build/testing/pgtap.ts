// Test harness only (WS05): runs one of the repo's pgTAP files (supabase/tests/*.sql) on PGlite
// through the shim in pgtap-shim.sql and reports the TAP lines. CI runs the same files with the
// real pgTAP; this gives the same answer before a push.
import { readFileSync } from "node:fs";
import type { TestDb } from "./db.ts";

export interface TapReport {
  /** Every TAP line the file produced, in order. */
  lines: string[];
  /** The `not ok` lines with their diagnostics. */
  failures: string[];
  /** The number of `ok` and `not ok` lines. */
  ran: number;
  /** The number in the `1..N` plan line, or null if the file printed none. */
  planned: number | null;
  /** Lines from finish() such as "# Looks like you failed 1 test(s) of 97". */
  summary: string[];
}

interface ExecResult {
  rows?: Array<Record<string, unknown>>;
}

/** Runs the file as one script and collects the TAP lines the `select` statements returned. */
export async function runPgTapFile(t: TestDb, path: string): Promise<TapReport> {
  const results = (await t.db.exec(readFileSync(path, "utf8"))) as ExecResult[];
  const lines: string[] = [];
  for (const result of results) {
    for (const row of result.rows ?? []) {
      for (const value of Object.values(row)) {
        if (typeof value === "string") lines.push(...value.split("\n"));
      }
    }
  }
  const failures: string[] = [];
  let ran = 0;
  let planned: number | null = null;
  const summary: string[] = [];
  for (const [index, line] of lines.entries()) {
    if (/^1\.\.\d+$/.test(line)) planned = Number(line.slice(3));
    else if (/^ok \d+/.test(line)) ran += 1;
    else if (/^not ok \d+/.test(line)) {
      ran += 1;
      const diagnostics: string[] = [line];
      for (let next = index + 1; next < lines.length; next++) {
        const following = lines[next] ?? "";
        if (!following.startsWith("#")) break;
        diagnostics.push(following);
      }
      failures.push(diagnostics.join("\n"));
    } else if (/^# Looks like/.test(line)) summary.push(line);
  }
  return { lines, failures, ran, planned, summary };
}
