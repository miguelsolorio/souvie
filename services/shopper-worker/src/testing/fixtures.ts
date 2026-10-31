// Test-only: a household with a 12-line grocery list, a mock store connection, and a member with
// allergies, in the PGlite harness that runs the real migrations
// (supabase/functions/run-approve/testing/db.ts). Ids are fixed so failures read clearly.
import {
  createRunsTestDb,
  type RunsTestDb,
} from "../../../../supabase/functions/run-approve/testing/db.ts";
import type { Logger } from "../queue.ts";

export const HOUSEHOLD = "0a000000-0000-4000-8000-0000000000a9";
export const OTHER_HOUSEHOLD = "0b000000-0000-4000-8000-0000000000b9";
export const ALICE = "a1111111-1111-4111-8111-1111111111a9";
export const BOB = "b2222222-2222-4222-8222-2222222222b9";
export const LIST = "9a000000-0000-4000-8000-0000000000a9";
export const CONNECTION = "7a000000-0000-4000-8000-0000000000a9";

/** name, category, default unit, density, unit weight; then the line: display, qty, unit, extras. */
const LINES: Array<{
  name: string;
  category: string;
  unit: string;
  density?: number;
  weight?: number;
  display: string;
  qty: number;
  lineUnit: string;
  qualifiers?: string[];
  rawTexts?: string[];
}> = [
  {
    name: "ws09 yellow onion",
    category: "produce",
    unit: "each",
    weight: 150,
    display: "Yellow onions",
    qty: 3,
    lineUnit: "each",
  },
  {
    name: "ws09 garlic",
    category: "produce",
    unit: "clove",
    weight: 5,
    display: "Garlic",
    qty: 1,
    lineUnit: "head",
  },
  {
    name: "ws09 chicken thigh",
    category: "meat",
    unit: "lb",
    weight: 115,
    display: "Boneless skinless chicken thighs",
    qty: 1.5,
    lineUnit: "lb",
  },
  {
    name: "ws09 whole milk",
    category: "dairy",
    unit: "cup",
    density: 1.03,
    display: "Whole milk",
    qty: 1,
    lineUnit: "gallon",
  },
  {
    name: "ws09 egg",
    category: "eggs",
    unit: "each",
    weight: 50,
    display: "Large eggs",
    qty: 12,
    lineUnit: "each",
  },
  {
    name: "ws09 oat milk",
    category: "dairy",
    unit: "cup",
    density: 1,
    display: "Oat milk",
    qty: 8,
    lineUnit: "cup",
  },
  {
    name: "ws09 spinach",
    category: "produce",
    unit: "cup",
    density: 0.12,
    display: "Baby spinach",
    qty: 1,
    lineUnit: "bag",
  },
  {
    name: "ws09 diced tomatoes",
    category: "canned",
    unit: "can",
    density: 1,
    display: "Diced tomatoes",
    qty: 2,
    lineUnit: "can",
    rawTexts: ["2 (14.5 oz) cans diced tomatoes"],
  },
  {
    name: "ws09 chicken broth",
    category: "pantry",
    unit: "cup",
    density: 1,
    display: "Chicken broth",
    qty: 4,
    lineUnit: "cup",
  },
  {
    name: "ws09 penne",
    category: "pantry",
    unit: "oz",
    density: 0.45,
    display: "Penne",
    qty: 16,
    lineUnit: "oz",
  },
  {
    name: "ws09 salmon fillet",
    category: "seafood",
    unit: "lb",
    weight: 170,
    display: "Salmon fillets",
    qty: 1.5,
    lineUnit: "lb",
  },
  {
    name: "ws09 baby carrots",
    category: "produce",
    unit: "each",
    display: "Carrots",
    qty: 1,
    lineUnit: "bag",
  },
];

export function lineId(index: number): string {
  return `8a000000-0000-4000-8000-${String(index + 1).padStart(12, "0")}`;
}

export function ingredientId(index: number): string {
  return `11111111-0000-4000-8000-${String(index + 900).padStart(12, "0")}`;
}

/** Names that strip the "ws09 " test prefix, so the mock catalog matches the ontology name. */
export async function seedHousehold(
  t: RunsTestDb,
  options: { allergies?: string[] } = {},
): Promise<void> {
  await t.exec(`
    insert into auth.users (id, email) values
      ('${ALICE}', 'alice-ws09@example.test'), ('${BOB}', 'bob-ws09@example.test');
    insert into public.households (id, name, created_by) values
      ('${HOUSEHOLD}', 'WS09 House', '${ALICE}'), ('${OTHER_HOUSEHOLD}', 'Other House', '${BOB}');
    insert into public.household_members (household_id, user_id, role) values
      ('${HOUSEHOLD}', '${ALICE}', 'owner'), ('${OTHER_HOUSEHOLD}', '${BOB}', 'owner');
    insert into public.grocery_lists (id, household_id, name) values ('${LIST}', '${HOUSEHOLD}', 'WS09 week');
    insert into public.retailer_connections (id, household_id, user_id, retailer, auth_type, store_id, store_name, modality, status)
      values ('${CONNECTION}', '${HOUSEHOLD}', '${ALICE}', 'kroger', 'none', 'MOCK0001', 'Mock QFC Duvall', 'pickup', 'active');
    insert into public.push_tokens (user_id, token, platform) values ('${ALICE}', 'ExponentPushToken[ws09-alice]', 'ios');
  `);
  if (options.allergies) {
    await t.query(
      `update public.profiles set preferences = jsonb_build_object('allergies', $2::jsonb) where user_id = $1`,
      [ALICE, JSON.stringify(options.allergies)],
    );
  }
  for (const [index, line] of LINES.entries()) {
    // The ontology name without the prefix is what a search sends; the prefix keeps the row unique.
    await t.query(
      `insert into public.ingredients (id, name, category, default_unit, density_g_per_ml, typical_unit_weight_g)
       values ($1, $2, $3, $4, $5, $6)`,
      [
        ingredientId(index),
        line.name,
        line.category,
        line.unit,
        line.density ?? null,
        line.weight ?? null,
      ],
    );
    await t.query(
      `insert into public.grocery_list_items (id, list_id, household_id, ingredient_id, display_name, qty, unit, section, position, qualifiers, detail)
       values ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)`,
      [
        lineId(index),
        LIST,
        HOUSEHOLD,
        ingredientId(index),
        line.display,
        line.qty,
        line.lineUnit,
        line.category,
        index,
        line.qualifiers ?? [],
        JSON.stringify({ contributions: line.rawTexts ? [{ rawTexts: line.rawTexts }] : [] }),
      ],
    );
  }
  // The search text is the ontology name; drop the prefix for the mock catalog.
  await t.exec(
    `update public.ingredients set name = replace(name, 'ws09 ', '') where name like 'ws09 %'`,
  );
}

/** Starts a run the way the app does, as the service role here (no signed-in user). */
export async function enqueue(
  t: RunsTestDb,
  policy: Record<string, unknown> = {},
): Promise<string> {
  const rows = await t.query<{ id: string }>(
    `select public.enqueue_shopping_run($1::uuid, $2::uuid, 'manual', $3::jsonb) as id`,
    [LIST, CONNECTION, JSON.stringify(policy)],
  );
  const id = rows[0]?.id;
  if (!id) throw new Error("enqueue returned nothing");
  return id;
}

export async function runRow(t: RunsTestDb, runId: string) {
  const rows = await t.query<{
    status: string;
    error: string | null;
    heartbeat_at: string | null;
    approved_at: string | null;
    subtotal_usd: string | null;
    cart_snapshot: Record<string, unknown> | null;
    transcript: unknown[];
    progress: Record<string, unknown>;
  }>(`select * from public.shopping_runs where id = $1`, [runId]);
  const row = rows[0];
  if (!row) throw new Error(`no run ${runId}`);
  return row;
}

export interface LogEntry {
  level: "info" | "warn" | "error";
  msg: string;
  fields?: Record<string, unknown> | undefined;
}

export function recorder(): Logger & { entries: LogEntry[] } {
  const entries: LogEntry[] = [];
  return {
    entries,
    info: (msg, fields) => void entries.push({ level: "info", msg, fields }),
    warn: (msg, fields) => void entries.push({ level: "warn", msg, fields }),
    error: (msg, fields) => void entries.push({ level: "error", msg, fields }),
  };
}

export { createRunsTestDb, type RunsTestDb };
