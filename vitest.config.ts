import { configDefaults, defineConfig } from "vitest/config";

// Two projects, split by file suffix.
// `unit`: every *.test.ts in the repo. `pnpm test` runs it.
// `evals`: *.eval.ts under an evals/ folder (golden sets, model-graded checks,
// docs/03-ai-design.md). Only `pnpm eval` runs it.
const EVAL_GLOB = "**/evals/**/*.eval.ts";
const EXCLUDE = [
  ...configDefaults.exclude,
  "**/dist/**",
  "**/.expo/**",
  "**/.turbo/**",
  "supabase/.temp/**",
];

export default defineConfig({
  test: {
    projects: [
      {
        test: {
          name: "unit",
          environment: "node",
          include: ["**/*.test.ts", "**/*.test.tsx"],
          exclude: [...EXCLUDE, EVAL_GLOB],
        },
      },
      {
        test: {
          name: "evals",
          environment: "node",
          include: [EVAL_GLOB],
          exclude: EXCLUDE,
          passWithNoTests: true,
        },
      },
    ],
  },
});
