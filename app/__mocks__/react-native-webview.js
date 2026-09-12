// Manual Jest mock for react-native-webview (auto-applied for any import
// of this module under test — see https://jestjs.io/docs/manual-mocks).
//
// The real component reaches into a genuine native-backed WKWebView and,
// on macOS specifically, needs react-native-macos's own custom Jest
// resolver/testEnvironment (for cross-package haste module resolution,
// e.g. Platform.macos.js overriding react-native's Platform.js) just to
// import cleanly — configuration this project does not take on for a
// component snapshot test. A snapshot test's job is to catch accidental
// structural/prop regressions in OUR components, not to re-verify a
// third-party native module; the real component's behavior is verified by
// actually running the packaged macOS app (see ViewportHost's B.2
// verification).
const React = require('react');
const { forwardRef, useImperativeHandle } = React;

const WebView = forwardRef((props, ref) => {
  useImperativeHandle(ref, () => ({
    reload: () => {},
    goBack: () => {},
    goForward: () => {},
    stopLoading: () => {},
    injectJavaScript: () => {},
  }));
  return React.createElement('WebView', props);
});
WebView.displayName = 'WebView';

module.exports = WebView;
module.exports.default = WebView;
module.exports.WebView = WebView;
