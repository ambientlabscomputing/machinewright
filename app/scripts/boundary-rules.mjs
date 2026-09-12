// Pure rule-checking functions for the design-system import/token boundary
// (RFD-19 "Enforcing the design language"). Kept separate from
// check-boundaries.mjs's filesystem walk so these are directly unit-testable
// (see tests/scripts/boundary-rules.test.ts) with the positive and negative
// fixtures RFD-19 explicitly asks for: "Add positive and negative lint
// fixtures proving that allowed wrapper imports pass and direct vendor
// imports, deep imports, re-export bypasses, and raw style values fail."

const RESTRICTED_PRIMITIVES = ["Text", "TextInput", "Pressable", "Button", "Switch", "View"];
const PRIMITIVE_GROUP = RESTRICTED_PRIMITIVES.join("|");

const RAW_COLOR = /['"]#[0-9a-fA-F]{3,8}['"]/;

const NAMED_IMPORT = new RegExp(
  `\\bimport\\s*\\{[^}]*\\b(?:${PRIMITIVE_GROUP})\\b[^}]*\\}\\s*from\\s*['"]react-native['"]`,
);
const RE_EXPORT = new RegExp(
  `\\bexport\\s*\\{[^}]*\\b(?:${PRIMITIVE_GROUP})\\b[^}]*\\}\\s*from\\s*['"]react-native['"]`,
);
// Broad on purpose: a CJS require or dynamic import of the *whole* module is
// itself the bypass RFD-19 warns about ("require, and dynamic imports"), so
// any use of either form for "react-native" is flagged rather than trying to
// detect which specific named property gets pulled off the result.
const CJS_REQUIRE = /\brequire\(\s*['"]react-native['"]\s*\)/;
const DYNAMIC_IMPORT = /\bimport\(\s*['"]react-native['"]\s*\)/;
const NAMESPACE_IMPORT = /\bimport\s+\*\s+as\s+(\w+)\s+from\s*['"]react-native['"]/;

/** True if `source` imports a restricted RN visual primitive by any route this script recognizes. */
export function hasRestrictedRnPrimitiveImport(source) {
  if (NAMED_IMPORT.test(source)) return true;
  if (RE_EXPORT.test(source)) return true;
  if (CJS_REQUIRE.test(source)) return true;
  if (DYNAMIC_IMPORT.test(source)) return true;

  const namespaceMatch = NAMESPACE_IMPORT.exec(source);
  if (namespaceMatch) {
    const alias = namespaceMatch[1];
    const propertyAccess = new RegExp(`\\b${alias}\\.(?:${PRIMITIVE_GROUP})\\b`);
    if (propertyAccess.test(source)) return true;
  }
  return false;
}

/** True if `source` contains a raw hex color literal. */
export function hasRawColorLiteral(source) {
  return RAW_COLOR.test(source);
}

export function isUnder(relativePath, exemptDirs, pathSep) {
  return exemptDirs.some((dir) => relativePath === dir || relativePath.startsWith(dir + pathSep));
}
