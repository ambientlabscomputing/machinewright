module.exports = {
  preset: 'react-native',
  // app/tests/ is Vitest's domain (plain TS/Node contract tests — see
  // vitest.config.ts); exclude it via testPathIgnorePatterns rather than
  // `roots`, which would also stop Jest from discovering __mocks__/ at
  // the project root (manual mocks for node_modules packages, e.g.
  // react-native-webview below, are only auto-applied from there).
  testPathIgnorePatterns: ['<rootDir>/node_modules/', '<rootDir>/tests/'],
  // react-native-webview is replaced by __mocks__/react-native-webview.js
  // (see that file for why) rather than transformed/resolved for real:
  // making its actual macOS native-component resolution work correctly
  // under Jest needs react-native-macos's own preset (custom haste
  // resolver + testEnvironment), which this project intentionally does not
  // take on for a component snapshot test — Metro's real bundling (already
  // verified end-to-end in the packaged app, see B.2's manual verification)
  // is the authority on whether the actual macOS WebView component works.
};
