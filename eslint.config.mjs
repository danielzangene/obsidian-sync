import { defineConfig, globalIgnores } from "eslint/config";
import obsidianmd from "eslint-plugin-obsidianmd";

// Layer boundaries from docs/DESIGN.md §3.1. Each layer lists what it must NOT import.
const layer = (files, forbidden) => ({
  files,
  rules: {
    "no-restricted-imports": [
      "error",
      {
        patterns: [
          {
            group: forbidden,
            message: "Layer boundary violation (see docs/DESIGN.md §3.1).",
          },
        ],
      },
    ],
  },
});

const APP = "**/app/**";
const PORTS = "**/ports/**";
const ADAPTERS = "**/adapters/**";
const UI = "**/ui/**";
const LIB = "**/lib/**";
const DOMAIN = "**/domain/**";

export default defineConfig([
  globalIgnores(["node_modules", "main.js", "esbuild.config.mjs", "version-bump.mjs"]),
  ...obsidianmd.configs.recommended,
  {
    languageOptions: {
      parserOptions: {
        projectService: {
          allowDefaultProject: ["eslint.config.mjs"],
        },
      },
    },
  },
  layer(["src/domain/**"], [APP, PORTS, ADAPTERS, UI, LIB, "obsidian"]),
  layer(["src/lib/**"], [APP, PORTS, ADAPTERS, UI, DOMAIN, "obsidian"]),
  layer(["src/ports/**"], [APP, ADAPTERS, UI, LIB, "obsidian"]),
  layer(["src/app/**"], [ADAPTERS, UI, "obsidian"]),
  layer(["src/adapters/google/**"], [APP, UI, "**/adapters/obsidian/**", "obsidian"]),
  layer(["src/adapters/system/**"], [APP, UI, "obsidian"]),
  layer(["src/adapters/obsidian/**"], [APP, UI]),
  layer(["src/ui/**"], [ADAPTERS]),
]);
