const fs = require("node:fs");
const path = require("node:path");
const { getDefaultConfig } = require("expo/metro-config");
const { withNativeWind } = require("nativewind/metro");

// The monorepo keeps one .env.local at the repo root (see .env.example). Expo only reads
// env files from this folder, so load the root file too. Values already in the
// environment, including apps/mobile/.env*, win.
const rootEnv = path.resolve(__dirname, "../../.env.local");
if (fs.existsSync(rootEnv)) {
  process.loadEnvFile(rootEnv);
}

// Expo detects the pnpm workspace and sets watchFolders and node_modules paths itself.
const config = getDefaultConfig(__dirname);

module.exports = withNativeWind(config, { input: "./global.css" });
