/**
 * Positive/negative fixtures for the design-system boundary rules (RFD-19
 * "Enforcing the design language": "Add positive and negative lint
 * fixtures proving that allowed wrapper imports pass and direct vendor
 * imports, deep imports, re-export bypasses, and raw style values fail").
 */
import { describe, expect, it } from "vitest";
import { hasRestrictedRnPrimitiveImport, hasRawColorLiteral, isUnder } from "../../scripts/boundary-rules.mjs";

describe("hasRestrictedRnPrimitiveImport", () => {
  it("flags a direct named import of a restricted primitive", () => {
    expect(hasRestrictedRnPrimitiveImport(`import { View, Text } from "react-native";`)).toBe(true);
  });

  it("flags a re-export bypass", () => {
    expect(hasRestrictedRnPrimitiveImport(`export { View } from "react-native";`)).toBe(true);
  });

  it("flags a CJS require of the whole module", () => {
    expect(hasRestrictedRnPrimitiveImport(`const { View } = require("react-native");`)).toBe(true);
  });

  it("flags a dynamic import", () => {
    expect(hasRestrictedRnPrimitiveImport(`import("react-native").then((rn) => rn.View);`)).toBe(true);
  });

  it("flags namespace-import property access", () => {
    expect(
      hasRestrictedRnPrimitiveImport(`import * as RN from "react-native";\nconst V = RN.View;`),
    ).toBe(true);
  });

  it("allows importing the design-system wrapper", () => {
    expect(hasRestrictedRnPrimitiveImport(`import { Text } from "../design-system/native";`)).toBe(
      false,
    );
  });

  it("allows importing non-visual react-native APIs by name", () => {
    expect(
      hasRestrictedRnPrimitiveImport(`import { StyleSheet, Platform } from "react-native";`),
    ).toBe(false);
  });

  it("allows a namespace import that never touches a restricted primitive", () => {
    expect(
      hasRestrictedRnPrimitiveImport(`import * as RN from "react-native";\nconst p = RN.Platform.OS;`),
    ).toBe(false);
  });
});

describe("hasRawColorLiteral", () => {
  it("flags a raw hex color string", () => {
    expect(hasRawColorLiteral(`const style = { color: "#FF0000" };`)).toBe(true);
  });

  it("flags a short 3-digit hex literal", () => {
    expect(hasRawColorLiteral(`const style = { color: "#fff" };`)).toBe(true);
  });

  it("allows a semantic token reference", () => {
    expect(hasRawColorLiteral(`const style = { color: colors.text.primary };`)).toBe(false);
  });
});

describe("isUnder", () => {
  it("matches an exact directory and its descendants, not siblings", () => {
    const exempt = ["src/design-system/native"];
    expect(isUnder("src/design-system/native", exempt, "/")).toBe(true);
    expect(isUnder("src/design-system/native/Button.tsx", exempt, "/")).toBe(true);
    expect(isUnder("src/design-system/nativefoo.ts", exempt, "/")).toBe(false);
    expect(isUnder("src/design-system/tokens/colors.ts", exempt, "/")).toBe(false);
  });
});
