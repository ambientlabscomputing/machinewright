/**
 * RFD-19 M3's "generate controls from typed inputs": one `Field` +
 * paired `Slider`/`NumericInput` per numeric leaf of the template's
 * `input_schema()`, composed entirely from the existing native design
 * system rather than a new form widget (RFD-19 "Enforcing the design
 * language" — feature screens compose approved components, they don't
 * assemble raw primitives).
 */
import { Field, NumericInput, Slider, Stack } from "../design-system/native";
import { flattenNumericFields, type JsonSchemaNode } from "./inputSchema";

export interface ControlPanelProps {
  readonly schema: JsonSchemaNode;
  readonly values: Readonly<Record<string, number>>;
  readonly onChange: (path: string, value: number) => void;
}

export function ControlPanel({ schema, values, onChange }: ControlPanelProps) {
  const fields = flattenNumericFields(schema);
  return (
    <Stack gap="md">
      {fields.map((field) => {
        const value = values[field.path] ?? field.default ?? field.minimum;
        return (
          <Field key={field.path} label={field.title}>
            <Stack direction="row" gap="sm" align="center">
              <Stack flex={1}>
                <Slider
                  value={value}
                  min={field.minimum}
                  max={field.maximum}
                  onChange={(next) => onChange(field.path, next)}
                  accessibilityLabel={field.title}
                />
              </Stack>
              <NumericInput
                value={value}
                min={field.minimum}
                max={field.maximum}
                onChange={(next) => onChange(field.path, next)}
                accessibilityLabel={`${field.title} value`}
              />
            </Stack>
          </Field>
        );
      })}
    </Stack>
  );
}
