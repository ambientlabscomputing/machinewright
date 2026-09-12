// @ts-check
import tseslint from "typescript-eslint";

// Token/import boundary enforcement (RFD-19 "Enforcing the design
// language") lives in scripts/check-boundaries.mjs (run as part of `npm run
// lint`) rather than here — RFD-19 explicitly calls for supplementing
// static ESLint import rules with a re-export/dynamic-import-aware walk,
// which is easier to express as a plain script than as ESLint rule
// composition. This config stays a general TS/RN baseline.
export default tseslint.config(
  {
    ignores: [
      "dist/**",
      "node_modules/**",
      "macos/**",
      "src/protocol/worker/**",
      "src/model/generated/**",
      // esbuild bundle output (scripts/build-web-*.mjs) — not committed
      // (see .gitignore), but excluded here too in case it exists locally.
      "web/*/dist/**",
      // React Native's own CommonJS tooling config, not app source.
      "metro.config.js",
      "babel.config.js",
      "jest.config.js",
      // Jest manual mocks (CommonJS by Jest convention — require()-based
      // so they load identically regardless of the mocked module's own
      // format).
      "__mocks__/**",
    ],
  },
  ...tseslint.configs.recommended,
  {
    rules: {
      "@typescript-eslint/no-unused-vars": ["warn", { argsIgnorePattern: "^_" }],
    },
  },
  // Static import restriction for raw RN visual primitives (RFD-19
  // "Enforcing the design language", check 1: "use ESLint
  // no-restricted-imports for vendor package names ... Restrict raw React
  // Native visual primitives ... to the native design system"). This is
  // deliberately supplemented, not replaced, by scripts/check-boundaries.mjs
  // (check 2: "a module-boundary rule that resolves aliases and relative
  // paths and checks re-exports, require, and dynamic imports" — an
  // import-specifier rule like this one cannot see those). App.tsx is
  // outside src/ and web/ and stays unrestricted for the same reason
  // check-boundaries.mjs exempts it: it's B.1-era spike scaffolding.
  {
    files: ["src/**/*.{ts,tsx}", "web/**/*.{ts,tsx}"],
    ignores: [
      "src/design-system/native/**",
      "src/protocol/worker/**",
      "src/model/generated/**",
      // Spike-only host components (B.2-B.5) predate the native design
      // system — see scripts/check-boundaries.mjs for the matching
      // exemption and why.
      "src/viewport/**",
      "src/editor/**",
      "src/app/**",
    ],
    rules: {
      "no-restricted-imports": [
        "error",
        {
          paths: [
            {
              name: "react-native",
              importNames: ["Text", "TextInput", "Pressable", "Button", "Switch", "View"],
              message:
                "Import from src/design-system/native instead (RFD-19 'Enforcing the design language').",
            },
          ],
        },
      ],
    },
  },
);
