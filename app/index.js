/**
 * @format
 */

// Hermes (React Native's JS engine) does not provide TextEncoder/TextDecoder
// on globalThis; @bufbuild/protobuf requires them (its generated file
// descriptors are decoded from a base64 string at module-eval time via
// BinaryReader) and constructs TextDecoder with `{ fatal: true }` for
// strict UTF-8 validation, which rules out minimal polyfills (e.g.
// fast-text-encoding) that don't implement the `fatal` option — this one
// (the reference WHATWG Encoding polyfill) does. Must be required before
// anything that imports generated protobuf code, including App.
import { TextEncoder, TextDecoder } from 'text-encoding';
Object.assign(global, { TextEncoder, TextDecoder });
import { AppRegistry } from 'react-native';
import App from './App';
import { name as appName } from './app.json';

AppRegistry.registerComponent(appName, () => App);
