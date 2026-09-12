# Native component library decision (RFD-19 open question #11)

RFD-19 leaves "which macOS-compatible component library covers the shell's
controls with the least custom styling and reliable keyboard/accessibility
support" open, framing the evaluation itself as part of the M1 spike
(candidates it names: plain `react-native-macos` primitives, a broader
library such as `react-native-paper`, or small custom Swift/AppKit modules
for a few high-touch controls).

**Decision: plain `react-native-macos` core primitives (`View`, `Text`,
`Pressable`, `TextInput`, `Switch`, `PanResponder`), wrapped directly in
`src/design-system/native/`.** No third-party component library.

## Why

Every third-party native-facing dependency this spike has actually
integrated so far turned out to have a real, undocumented macOS gap that
needed direct investigation to find:

- `react-native-webview` claims macOS support (dedicated `.macos.tsx`
  files) and still shipped a stale root `index.d.ts` that breaks
  TypeScript, a macOS ref type erased to `unknown`, and two separate
  file-access preferences (`allowingReadAccessToURL` vs
  `allowFileAccessFromFileURLs`/`allowUniversalAccessFromFileURLs`) that
  are each necessary and easy to miss (B.2/B.4/B.5 all hit one of these).
- Getting `react-native-webview` to even import cleanly under Jest needed
  `react-native-macos`'s own custom haste resolver and a manual mock
  (B.3).

`react-native-paper` — the RFD's suggested second candidate — doesn't
claim macOS support at all (no `.macos.*` platform files, package
description is generically "Material design for React Native"). Adopting
it would mean debugging the same class of platform gaps again, for a
dependency with *no* stated macOS support to start from, purely to get
`Button`/`Slider`-shaped components this project can wrap in a few dozen
lines using primitives that are already known to work on this platform
(every spike screen B.1-B.5 already renders `View`/`Text`/`Pressable`
successfully).

Small custom Swift/AppKit-bridged controls (the RFD's third candidate)
are worth revisiting for specific high-touch controls later (native
sliders/steppers, per the "Aesthetics" section's tactility requirements)
but are not needed to close *this* milestone's "establish wrappers and a
component gallery" bullet, and add native-module surface area with no
current control gap that plain RN primitives can't already fill.

## Revisit when

- A control genuinely can't be built acceptably from RN core primitives
  (native-feeling sliders/steppers are the most likely candidate — see
  `Slider.tsx`'s doc comment for the specific gap this wrapper leaves
  open).
- `react-native-paper` (or another library) publishes explicit macOS
  support with the same rigor `react-native-webview` claims — "claims
  support" has not been a reliable predictor of "works" for this project
  so far, so re-verify empirically rather than trusting the claim alone.
