import { describe, expect, it } from "vitest";
import { materialClass } from "../../web/viewport/src/materials";
import { colors } from "../../src/design-system/tokens/colors";

describe("materialClass", () => {
  it.each([
    ["PLA", "printed"],
    ["PETG", "printed"],
    ["PETG-CF", "printed"],
    ["6061-T6 Aluminum", "machined"],
    ["Off-the-shelf hardware", "purchased"],
    ["Unobtainium", "other"],
    [null, "other"],
  ] as const)("%s -> %s", (name, expected) => {
    expect(materialClass(name)).toBe(expected);
  });

  it("prefers the declared process over the name", () => {
    expect(materialClass("Steel", "PURCHASED")).toBe("purchased");
    expect(materialClass("PA6-GF", "PRINTED")).toBe("printed");
    expect(materialClass("Wound electrical steel", "PURCHASED")).toBe("purchased");
  });

  it("every class has a design-token color", () => {
    for (const cls of ["printed", "machined", "purchased", "sheet", "other"] as const) {
      expect(colors.material[cls]).toMatch(/^#[0-9A-F]{6}$/i);
    }
  });
});
