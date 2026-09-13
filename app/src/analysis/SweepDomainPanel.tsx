/**
 * Lets an engineer pick one or two numeric input fields as sweep axes
 * (RFD-19's "One- and two-dimensional parameter sweeps") and configure each
 * axis's domain via `RangeField`, then start or cancel the sweep. Composed
 * entirely from existing native design-system primitives — the "sweep this
 * field" toggle reuses `Button`'s existing neutral/action tone pairing
 * rather than a new checkbox/switch component the design system doesn't
 * have yet.
 */
import { useState } from "react";
import { Button, Stack, StatusBadge, Text } from "../design-system/native";
import { flattenNumericFields, type JsonSchemaNode } from "./inputSchema";
import { RangeField } from "./RangeField";
import type { SweepAxis } from "./sweepDomain";

const MAX_AXES = 2;

export interface SweepDomainPanelProps {
  readonly schema: JsonSchemaNode;
  readonly running: boolean;
  readonly onStart: (axes: readonly SweepAxis[]) => void;
  readonly onCancel: () => void;
}

export function SweepDomainPanel({ schema, running, onStart, onCancel }: SweepDomainPanelProps) {
  const fields = flattenNumericFields(schema);
  const [axesByPath, setAxesByPath] = useState<Readonly<Record<string, SweepAxis>>>({});

  const selectedPaths = Object.keys(axesByPath);

  function toggle(path: string, minimum: number, maximum: number) {
    setAxesByPath((current) => {
      if (path in current) {
        return Object.fromEntries(Object.entries(current).filter(([candidate]) => candidate !== path));
      }
      if (Object.keys(current).length >= MAX_AXES) return current; // at most 2 axes
      return {
        ...current,
        [path]: { parameterPath: path, start: minimum, stop: maximum, points: 5 },
      };
    });
  }

  function updateAxis(path: string, axis: SweepAxis) {
    setAxesByPath((current) => ({ ...current, [path]: axis }));
  }

  return (
    <Stack gap="md">
      <Stack direction="row" gap="sm" wrap>
        {fields.map((field) => (
          <Button
            key={field.path}
            label={field.title}
            tone={field.path in axesByPath ? "action" : "neutral"}
            size="compact"
            disabled={running}
            onPress={() => toggle(field.path, field.minimum, field.maximum)}
          />
        ))}
      </Stack>

      {selectedPaths.length === 0 ? (
        <Text variant="body" tone="secondary">
          Select one or two fields above to sweep.
        </Text>
      ) : null}

      {selectedPaths.map((path) => {
        const field = fields.find((candidate) => candidate.path === path);
        const axis = axesByPath[path];
        if (field === undefined || axis === undefined) return null;
        return (
          <RangeField
            key={path}
            title={field.title}
            minimum={field.minimum}
            maximum={field.maximum}
            axis={axis}
            onChange={(next) => updateAxis(path, next)}
          />
        );
      })}

      <Stack direction="row" gap="sm" align="center">
        {running ? (
          <>
            <StatusBadge tone="pending" label="Sweep running" />
            <Button label="Cancel sweep" tone="neutral" onPress={onCancel} />
          </>
        ) : (
          <Button
            label="Run sweep"
            tone="action"
            disabled={selectedPaths.length === 0}
            onPress={() => onStart(Object.values(axesByPath))}
          />
        )}
      </Stack>
    </Stack>
  );
}
