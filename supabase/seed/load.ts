// Ontology seed loader (WS03).
//
// Reads supabase/seed/ingredients.csv and ingredient_aliases.csv and renders
// supabase/seed/10_ingredients.sql, which `supabase db reset` (and `supabase db push
// --include-seed`) runs after the migrations. The SQL is idempotent: re-running it upserts.
//
//   node supabase/seed/load.ts            write 10_ingredients.sql
//   node supabase/seed/load.ts --check    fail if the committed SQL is out of date
//
// Ingredient ids are UUID v5 of the name, so they are the same on every machine and in every
// environment, and the golden-set eval can use them without a database.
//
// This module also exports `readSeed` for tests and the eval. Plain Node, no dependencies.

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));

/** Fixed namespace for ingredient ids. Never change it: every stored id derives from it. */
export const INGREDIENT_NAMESPACE = "6f1d1c0e-3a3b-4b8e-9d27-0b7a6a5f8c11";

export interface SeedIngredient {
  id: string;
  name: string;
  plural: string | null;
  category: string;
  defaultUnit: string;
  densityGPerMl: number | null;
  typicalUnitWeightG: number | null;
  usdaFdcId: number | null;
  isStapleDefault: boolean;
}

export interface SeedAlias {
  ingredientName: string;
  alias: string;
  source: "seed" | "llm" | "user";
}

export interface Seed {
  ingredients: SeedIngredient[];
  aliases: SeedAlias[];
}

/** UUID v5 (RFC 9562 section 5.5): SHA-1 of namespace bytes plus name. */
export function uuidV5(name: string, namespace: string = INGREDIENT_NAMESPACE): string {
  const ns = Buffer.from(namespace.replace(/-/g, ""), "hex");
  const hash = createHash("sha1").update(ns).update(name, "utf8").digest();
  const bytes = Buffer.from(hash.subarray(0, 16));
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const h = bytes.toString("hex");
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}

export function ingredientId(name: string): string {
  return uuidV5(name);
}

/** Minimal RFC 4180 CSV: quoted fields, doubled quotes, CRLF or LF. */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let row: string[] = [];
  let field = "";
  let quoted = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i] as string;
    if (quoted) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else quoted = false;
      } else field += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ",") {
      row.push(field);
      field = "";
    } else if (ch === "\n" || ch === "\r") {
      if (ch === "\r" && text[i + 1] === "\n") i++;
      row.push(field);
      field = "";
      if (row.length > 1 || row[0] !== "") rows.push(row);
      row = [];
    } else field += ch;
  }
  if (field !== "" || row.length > 0) {
    row.push(field);
    rows.push(row);
  }
  return rows;
}

function num(value: string | undefined): number | null {
  if (value === undefined || value.trim() === "") return null;
  const n = Number(value);
  if (!Number.isFinite(n)) throw new Error(`not a number: ${value}`);
  return n;
}

export const INGREDIENT_HEADER =
  "name,plural,category,default_unit,density_g_per_ml,typical_unit_weight_g,usda_fdc_id,is_staple_default";
export const ALIAS_HEADER = "ingredient_name,alias,source";

export function readSeed(dir: string = HERE): Seed {
  const ingText = readFileSync(join(dir, "ingredients.csv"), "utf8");
  const aliasText = readFileSync(join(dir, "ingredient_aliases.csv"), "utf8");
  const ingRows = parseCsv(ingText);
  const aliasRows = parseCsv(aliasText);
  if (ingRows[0]?.join(",") !== INGREDIENT_HEADER)
    throw new Error("ingredients.csv: unexpected header");
  if (aliasRows[0]?.join(",") !== ALIAS_HEADER)
    throw new Error("ingredient_aliases.csv: unexpected header");

  const ingredients: SeedIngredient[] = ingRows.slice(1).map((r, i) => {
    const [name, plural, category, defaultUnit, density, weight, usda, staple] = r;
    if (!name || !category || !defaultUnit)
      throw new Error(`ingredients.csv row ${i + 2}: missing field`);
    return {
      id: ingredientId(name),
      name,
      plural: plural ? plural : null,
      category,
      defaultUnit,
      densityGPerMl: num(density),
      typicalUnitWeightG: num(weight),
      usdaFdcId: num(usda),
      isStapleDefault: staple === "true",
    };
  });
  const aliases: SeedAlias[] = aliasRows.slice(1).map((r, i) => {
    const [ingredientName, alias, source] = r;
    if (!ingredientName || !alias)
      throw new Error(`ingredient_aliases.csv row ${i + 2}: missing field`);
    if (source !== "seed" && source !== "llm" && source !== "user") {
      throw new Error(`ingredient_aliases.csv row ${i + 2}: bad source ${source}`);
    }
    return { ingredientName, alias, source };
  });
  return { ingredients, aliases };
}

const q = (s: string): string => `'${s.replace(/'/g, "''")}'`;
const n = (v: number | null): string => (v === null ? "null" : String(v));

function chunks<T>(list: readonly T[], size: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

export function renderSeedSql(seed: Seed): string {
  const lines: string[] = [
    "-- Generated by supabase/seed/load.ts from ingredients.csv and ingredient_aliases.csv.",
    "-- Do not edit by hand: change the CSVs and run `node supabase/seed/load.ts`.",
    "-- Idempotent: re-running upserts by ingredient name and alias.",
    "",
  ];
  for (const part of chunks(seed.ingredients, 250)) {
    lines.push(
      "insert into public.ingredients (id, name, plural, category, default_unit, density_g_per_ml, typical_unit_weight_g, usda_fdc_id, is_staple_default)",
      "values",
      part
        .map(
          (i) =>
            `  (${q(i.id)}, ${q(i.name)}, ${i.plural === null ? "null" : q(i.plural)}, ${q(i.category)}, ${q(i.defaultUnit)}, ${n(i.densityGPerMl)}, ${n(i.typicalUnitWeightG)}, ${n(i.usdaFdcId)}, ${i.isStapleDefault})`,
        )
        .join(",\n"),
      "on conflict (name) do update set",
      "  plural = excluded.plural,",
      "  category = excluded.category,",
      "  default_unit = excluded.default_unit,",
      "  density_g_per_ml = excluded.density_g_per_ml,",
      "  typical_unit_weight_g = excluded.typical_unit_weight_g,",
      "  usda_fdc_id = excluded.usda_fdc_id,",
      "  is_staple_default = excluded.is_staple_default;",
      "",
    );
  }
  for (const part of chunks(seed.aliases, 500)) {
    lines.push(
      "insert into public.ingredient_aliases (ingredient_id, alias, source)",
      "select i.id, v.alias, v.source::public.ingredient_aliases_source",
      "from (values",
      part.map((a) => `  (${q(a.ingredientName)}, ${q(a.alias)}, ${q(a.source)})`).join(",\n"),
      ") as v (ingredient_name, alias, source)",
      "join public.ingredients as i on i.name = v.ingredient_name",
      "on conflict (alias) do update set ingredient_id = excluded.ingredient_id",
      "  where public.ingredient_aliases.source = 'seed';",
      "",
    );
  }
  return lines.join("\n");
}

export const SEED_SQL_PATH = join(HERE, "10_ingredients.sql");

function main(): void {
  const sql = renderSeedSql(readSeed());
  if (process.argv.includes("--check")) {
    const current = readFileSync(SEED_SQL_PATH, "utf8");
    if (current !== sql) {
      console.error(
        "supabase/seed/10_ingredients.sql is out of date. Run: node supabase/seed/load.ts",
      );
      process.exit(1);
    }
    console.log("10_ingredients.sql is up to date");
    return;
  }
  writeFileSync(SEED_SQL_PATH, sql);
  const seed = readSeed();
  console.log(
    `wrote ${SEED_SQL_PATH}: ${seed.ingredients.length} ingredients, ${seed.aliases.length} aliases`,
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) main();
