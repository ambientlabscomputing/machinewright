import { defineConfig } from "vitest/config";

// Vitest owns app/tests/ (protocol/model contract tests — plain TS/Node,
// no RN runtime needed). __tests__/ is the RN component test that ships
// with the react-native template; it needs Jest's react-native preset
// (Flow syntax, RN's own Babel transform) and is run separately via
// `npm run test:app`. Keeping these two runners apart avoids fighting
// Metro/Jest's RN-specific transform inside Vitest's esbuild pipeline.
export default defineConfig({
  test: {
    include: ["tests/**/*.test.ts"],
  },
});
