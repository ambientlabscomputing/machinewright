import { describe, expect, it } from "vitest";
import { flattenNumericFields } from "../../src/analysis/inputSchema";

// Real shape of `MachineTemplate.input_schema()` for the reference template
// (machinewright.reference.simple@1.0.0), reproduced verbatim from `uv run
// python -c "...input_schema()..."` rather than hand-simplified, so this
// test tracks the actual Python output shape.
const REFERENCE_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  title: "machinewright.reference.simple@1.0.0 inputs",
  type: "object",
  additionalProperties: false,
  properties: {
    requirements: {
      additionalProperties: false,
      properties: {
        schema_version: { const: "1.0", default: "1.0", title: "Schema Version", type: "string" },
        payload_kg: {
          default: 10.0,
          exclusiveMinimum: 0,
          maximum: 100,
          title: "Payload Kg",
          type: "number",
        },
      },
      title: "ReferenceInputs",
      type: "object",
    },
  },
  required: ["requirements"],
};

describe("flattenNumericFields", () => {
  it("flattens the reference template's schema to one dotted-path numeric field", () => {
    const fields = flattenNumericFields(REFERENCE_SCHEMA);
    expect(fields).toHaveLength(1);
    const field = fields[0]!;
    expect(field.path).toBe("requirements.payload_kg");
    expect(field.title).toBe("Payload Kg");
    expect(field.maximum).toBe(100);
    expect(field.default).toBe(10);
    // payload_kg's schema constraint is `exclusiveMinimum: 0` (Pydantic
    // `gt=0`) — the resolved control range must never actually reach 0,
    // or a default 1D sweep spanning [minimum, maximum] would evaluate a
    // point the Python model rejects on every run (see RangeField/
    // SweepDomainPanel's default axis, which starts at `field.minimum`).
    expect(field.minimum).toBeGreaterThan(0);
  });

  it("nudges an exclusive bound strictly inside the excluded value, not equal to it", () => {
    const fields = flattenNumericFields({
      properties: { x: { type: "number", title: "X", exclusiveMinimum: 0, exclusiveMaximum: 10 } },
    });
    const field = fields[0]!;
    expect(field.minimum).toBeGreaterThan(0);
    expect(field.maximum).toBeLessThan(10);
  });

  it("uses an inclusive minimum/maximum exactly as given, unnudged", () => {
    const fields = flattenNumericFields({
      properties: { x: { type: "number", title: "X", minimum: 0, maximum: 10 } },
    });
    expect(fields[0]).toMatchObject({ minimum: 0, maximum: 10 });
  });

  it("skips schema_version and const fields", () => {
    const fields = flattenNumericFields({
      properties: {
        schema_version: { const: "1.0", type: "string" },
        note: { const: "fixed", type: "string" },
      },
    });
    expect(fields).toEqual([]);
  });

  it("skips $ref fields (nested typed contracts like Quantity, not resolved in this first cut)", () => {
    const fields = flattenNumericFields({
      properties: { speed: { $ref: "#/$defs/Quantity" } },
    });
    expect(fields).toEqual([]);
  });

  it("falls back to a wide bound when the schema gives no minimum/maximum", () => {
    const fields = flattenNumericFields({ properties: { x: { type: "number", title: "X" } } });
    expect(fields).toHaveLength(1);
    expect(fields[0]?.minimum).toBeLessThan(0);
    expect(fields[0]?.maximum).toBeGreaterThan(0);
  });

  it("recurses through nested objects two levels deep", () => {
    const fields = flattenNumericFields({
      properties: {
        a: { properties: { b: { properties: { c: { type: "number", title: "C" } } } } },
      },
    });
    expect(fields.map((f) => f.path)).toEqual(["a.b.c"]);
  });
});
