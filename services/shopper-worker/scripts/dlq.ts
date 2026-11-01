// The dead letter commands (WS15):
//
//   pnpm --filter @mp/shopper-worker dlq:list
//   pnpm --filter @mp/shopper-worker dlq:retry <msg_id> [--new-run] [--force]
//
// Both read WORKER_DATABASE_URL (the root .env.local is loaded by the package script) and connect
// as the database owner, because pgmq belongs to that role. The logic and the rules for what a
// retry does are in src/observability/dlq.ts. Nothing here prints a connection string.
import postgres from "postgres";
import {
  describeRetry,
  formatDeadLetter,
  listDeadLetters,
  retryDeadLetter,
} from "../src/observability/dlq.ts";
import { type PgClient, runnerOf } from "../src/sql.ts";

const [command, ...rest] = process.argv.slice(2);
const flags = new Set(rest.filter((arg) => arg.startsWith("--")));
const positional = rest.filter((arg) => !arg.startsWith("--"));

function usage(): never {
  console.error(
    [
      "usage:",
      "  dlq:list",
      "  dlq:retry <msg_id> [--new-run] [--force]",
      "",
      "The dead letter is pgmq's archive, pgmq.a_shopping_run (a message goes there after three failed attempts).",
    ].join("\n"),
  );
  process.exit(2);
}

const databaseUrl = process.env.WORKER_DATABASE_URL?.trim();
if (!databaseUrl) {
  console.error(
    "WORKER_DATABASE_URL is not set. Copy .env.example to .env.local and add the database connection string.",
  );
  process.exit(2);
}
if (command !== "list" && command !== "retry") usage();

const sql = postgres(databaseUrl, {
  max: 1,
  connect_timeout: 10,
  onnotice: () => {},
  connection: { application_name: "shopper-worker-dlq" },
});

try {
  const runner = runnerOf(sql as unknown as PgClient);
  if (command === "list") {
    const letters = await listDeadLetters(runner);
    if (letters.length === 0) console.log("The dead letter queue is empty.");
    for (const letter of letters) console.log(formatDeadLetter(letter));
    if (letters.length > 0) console.log(`\n${letters.length} dead letter(s).`);
  } else {
    const msgId = positional[0];
    if (!msgId) usage();
    const outcome = await retryDeadLetter(runner, msgId, {
      force: flags.has("--force"),
      newRun: flags.has("--new-run"),
    });
    console.log(describeRetry(outcome, msgId));
    if (outcome.kind !== "requeued" && outcome.kind !== "new_run") process.exitCode = 1;
  }
} catch (error) {
  console.error(error instanceof Error ? error.message : String(error));
  process.exitCode = 1;
} finally {
  await sql.end({ timeout: 2 });
}
