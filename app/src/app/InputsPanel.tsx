import { useEffect, useState } from "react";
import { ScrollView, TextInput } from "react-native";
import { Button, Field, Panel, Stack, Text } from "../design-system/native";
import { colors } from "../design-system/tokens/colors";
import { spacing } from "../design-system/tokens/spacing";
import { radius } from "../design-system/tokens/shape";
import type { JsonSchemaNode } from "../analysis/inputSchema";

export type InputValues = Record<string, unknown>;

function isObject(value: unknown): value is InputValues {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

export function parseInputs(text: string): InputValues {
  const value: unknown = JSON.parse(text);
  if (!isObject(value)) throw new Error("Input configuration must be a JSON object.");
  return value;
}

export function setInput(values: InputValues, [name, ...rest]: readonly string[], value: unknown): InputValues {
  if (name === undefined) return values;
  const child = Object.hasOwn(values, name) ? values[name] : undefined;
  return {
    ...values,
    [name]: rest.length ? setInput(isObject(child) ? child : {}, rest, value) : value,
  };
}

function inferSchema(value: unknown): JsonSchemaNode {
  if (isObject(value)) {
    return { properties: Object.fromEntries(Object.entries(value).map(([key, item]) => [key, inferSchema(item)])) };
  }
  return { type: typeof value };
}

interface InputField {
  readonly path: readonly string[];
  readonly label: string;
  readonly schema: JsonSchemaNode;
  readonly value: unknown;
}

function fieldsFor(schema: JsonSchemaNode, values: InputValues, path: readonly string[] = []): InputField[] {
  return Object.entries(schema.properties ?? {}).flatMap(([key, property]) => {
    const ref = property.$ref?.match(/^#\/\$defs\/([^/]+)$/)?.[1];
    const node = ref ? (schema.$defs?.[ref] ?? property) : property;
    const childPath = [...path, key];
    const value = Object.hasOwn(values, key) ? values[key] : node.default;
    if (node.const !== undefined || key === "schema_version") return [];
    if (node.properties && (node.type === "object" || !node.type)) {
      return fieldsFor(node, isObject(value) ? value : {}, childPath);
    }
    return [{ path: childPath, label: childPath.join("."), schema: node, value }];
  });
}

function parseField(raw: string, schema: JsonSchemaNode): unknown {
  if (schema.type === "string") {
    if (schema.enum && !schema.enum.includes(raw)) throw new Error("Choose one of the listed values.");
    return raw;
  }
  if (schema.type === "number" || schema.type === "integer") {
    const value = Number(raw);
    if (!raw.trim() || !Number.isFinite(value) || (schema.type === "integer" && !Number.isInteger(value))) {
      throw new Error(schema.type === "integer" ? "Enter a whole number." : "Enter a number.");
    }
    if (schema.minimum !== undefined && value < schema.minimum) throw new Error(`Enter ${schema.minimum} or more.`);
    if (schema.maximum !== undefined && value > schema.maximum) throw new Error(`Enter ${schema.maximum} or less.`);
    if (schema.exclusiveMinimum !== undefined && value <= schema.exclusiveMinimum) throw new Error(`Enter more than ${schema.exclusiveMinimum}.`);
    if (schema.exclusiveMaximum !== undefined && value >= schema.exclusiveMaximum) throw new Error(`Enter less than ${schema.exclusiveMaximum}.`);
    if (schema.enum && !schema.enum.includes(value)) throw new Error("Choose one of the listed values.");
    return value;
  }
  return JSON.parse(raw) as unknown;
}

function InputControl({ field, onChange }: { field: InputField; onChange: (value: unknown) => void }) {
  const { label, value, schema } = field;
  const formatted = schema.type === "string" ? String(value ?? "") : JSON.stringify(value) ?? "";
  const [draft, setDraft] = useState(formatted);
  const [error, setError] = useState("");
  useEffect(() => {
    setDraft(formatted);
    setError("");
  }, [formatted]);

  function commit(raw: string) {
    if (raw === formatted) return;
    try {
      onChange(parseField(raw, schema));
      setError("");
    } catch (problem) {
      setError(problem instanceof SyntaxError ? "Enter a valid JSON value." : String((problem as Error).message));
    }
  }

  const choices = schema.type === "boolean" ? [true, false] : schema.enum;
  return (
    <Field label={label} hint={error || schema.description}>
      {choices?.length && choices.every((item) => ["boolean", "number", "string"].includes(typeof item)) ? (
        <Stack direction="row" gap="xs" wrap>
          {choices.map((item) => (
            <Button key={JSON.stringify(item)} label={String(item)} size="compact"
              accessibilityLabel={`${label}: ${String(item)}`}
              tone={Object.is(item, value) ? "action" : "neutral"} onPress={() => onChange(item)} />
          ))}
        </Stack>
      ) : (
        <TextInput
          accessibilityLabel={label}
          value={draft}
          onChangeText={setDraft}
          onEndEditing={(event) => commit(event.nativeEvent.text)}
          autoCorrect={false}
          style={{
            backgroundColor: colors.surface.control,
            color: colors.text.primary,
            borderColor: colors.border.subtle,
            borderWidth: 1,
            borderRadius: radius.control,
            padding: spacing.sm,
          }}
        />
      )}
    </Field>
  );
}

export function InputsPanel({ schema, values, error, onChange, onReset, canReset }: {
  schema: JsonSchemaNode | null;
  values: InputValues;
  error: string | null;
  onChange: (path: readonly string[], value: unknown) => void;
  onReset: () => void;
  canReset: boolean;
}) {
  const fields = fieldsFor(schema ?? inferSchema(values), values);
  return (
    <Panel surface="panel" flex={1} bordered padding="sm">
      <ScrollView>
        <Stack gap="sm">
          {error ? <Text tone="action">{error}</Text> : null}
          {fields.length ? (
            <>
              <Text tone="secondary" variant="label">Preview values apply for this session.</Text>
              {fields.map((field) => (
                <InputControl key={JSON.stringify(field.path)} field={field} onChange={(value) => onChange(field.path, value)} />
              ))}
              <Button label="Reset Inputs" size="compact" disabled={!canReset} onPress={onReset} />
            </>
          ) : <Text tone="secondary">{schema ? "This template has no editable inputs." : "Inputs appear when a project supplies them."}</Text>}
        </Stack>
      </ScrollView>
    </Panel>
  );
}
