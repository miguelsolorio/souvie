const fs = require("node:fs");
const path = require("node:path");
const { parseEnv } = require("node:util");
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

// The monorepo keeps one .env.local at the repo root (see .env.example). Expo only reads
// env files from this folder, so copy the root file's EXPO_PUBLIC_* values in too. Nothing
// else from that file enters Metro's process: the service-role key and the database URL
// belong to the worker and Edge Functions only (docs/05-security-privacy.md). Values
// already in the environment, including apps/mobile/.env*, win.
const rootEnv = path.resolve(__dirname, "../../.env.local");
if (fs.existsSync(rootEnv)) {
  const parsed = parseEnv(fs.readFileSync(rootEnv, "utf8"));
  for (const [key, value] of Object.entries(parsed)) {
    if (key.startsWith("EXPO_PUBLIC_") && process.env[key] === undefined) {
      process.env[key] = value;
    }
  }
}

// Expo detects the pnpm workspace and sets watchFolders and node_modules paths itself.
const config = getDefaultConfig(__dirname);

module.exports = withNativeWind(config, { input: "./global.css" });
