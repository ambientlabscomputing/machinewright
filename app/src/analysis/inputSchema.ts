/**
 * RFD-19 M3's "generate controls from typed inputs": flattens the JSON
 * Schema `MachineTemplate.input_schema()` already produces
 * (src/machinewright/templates.py) into one control spec per numeric leaf
 * field, addressed by the same dotted path the sweep executor's
 * `SweepCoordinate.parameter_path` uses (src/machinewright/evaluation.py) —
 * so a field picked here for a control or a sweep axis needs no translation
 * to reach the worker.
 *
 * Deliberately narrow for a first cut: only `number`/`integer` leaves are
 * flattened (no `$ref`-nested types like `Quantity`, no arrays, no
 * enums/booleans) and `schema_version`/`const` fields are skipped — they
 * are structural, not editable inputs. Extending coverage is additive, not
 * a breaking change to this shape.
 */

export interface JsonSchemaNode {
  readonly type?: string;
  readonly $defs?: Readonly<Record<string, JsonSchemaNode>>;
  readonly description?: string;
  readonly enum?: readonly unknown[];
  readonly properties?: Readonly<Record<string, JsonSchemaNode>>;
  readonly minimum?: number;
  readonly maximum?: number;
  readonly exclusiveMinimum?: number;
  readonly exclusiveMaximum?: number;
  readonly default?: unknown;
  readonly title?: string;
  readonly const?: unknown;
  readonly $ref?: string;
}

export interface NumericFieldSpec {
  readonly path: string;
  readonly title: string;
  readonly minimum: number;
  readonly maximum: number;
  readonly default: number | null;
}

const FALLBACK_BOUND = 1_000_000;

/**
 * Resolves a usable [min, max] range from a schema's `minimum`/`maximum`
 * and `exclusiveMinimum`/`exclusiveMaximum`. An exclusive bound is a value
 * the field must never equal (e.g. `payload_kg`'s `exclusiveMinimum: 0`
 * means "> 0", not ">= 0") — treating it as if it were inclusive lets a
 * control default to exactly that excluded value, which the Python side
 * then rejects on every evaluation. Exclusive bounds are nudged inward by a
 * small fraction of the range instead.
 */
function resolveRange(
  minimum: number | undefined,
  maximum: number | undefined,
  exclusiveMinimum: number | undefined,
  exclusiveMaximum: number | undefined,
): { minimum: number; maximum: number } {
  const rawMin = minimum ?? exclusiveMinimum ?? -FALLBACK_BOUND;
  const rawMax = maximum ?? exclusiveMaximum ?? FALLBACK_BOUND;
  const span = rawMax - rawMin;
  const epsilon = Math.max(Math.abs(span) * 0.001, 1e-6);
  return {
    minimum: minimum === undefined && exclusiveMinimum !== undefined ? rawMin + epsilon : rawMin,
    maximum: maximum === undefined && exclusiveMaximum !== undefined ? rawMax - epsilon : rawMax,
  };
}

/** Flattens every numeric leaf of `schema` (as produced by `input_schema()`) into dotted-path control specs, recursing into nested object properties. */
export function flattenNumericFields(schema: JsonSchemaNode, pathPrefix: readonly string[] = []): NumericFieldSpec[] {
  const results: NumericFieldSpec[] = [];
  const properties = schema.properties ?? {};
  for (const [key, value] of Object.entries(properties)) {
    if (key === "schema_version" || value.const !== undefined || value.$ref !== undefined) continue;
    const path = [...pathPrefix, key];
    if (value.properties !== undefined) {
      results.push(...flattenNumericFields(value, path));
      continue;
    }
    if (value.type === "number" || value.type === "integer") {
      const { minimum, maximum } = resolveRange(
        value.minimum,
        value.maximum,
        value.exclusiveMinimum,
        value.exclusiveMaximum,
      );
      results.push({
        path: path.join("."),
        title: value.title ?? key,
        minimum,
        maximum,
        default: typeof value.default === "number" ? value.default : null,
      });
    }
  }
  return results;
}
