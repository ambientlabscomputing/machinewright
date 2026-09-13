/**
 * The one small composite this milestone adds beyond the existing native
 * design system: no approved control models "pick a domain" (min/start,
 * max/stop, point count) for one field, so `RangeField` composes `Field` +
 * three `NumericInput`s rather than inventing a bespoke interval widget.
 * Sweep domains are configured entirely client-side against the schema
 * `input_schema()` already produces — no Python "this field is sweepable"
 * declaration exists (or is needed) for M3.
 */
import { Field, NumericInput, Stack, Text } from "../design-system/native";
import type { SweepAxis } from "./sweepDomain";

export interface RangeFieldProps {
  readonly title: string;
  readonly minimum: number;
  readonly maximum: number;
  readonly axis: SweepAxis;
  readonly onChange: (axis: SweepAxis) => void;
}

export function RangeField({ title, minimum, maximum, axis, onChange }: RangeFieldProps) {
  return (
    <Field label={title}>
      <Stack direction="row" gap="sm" align="center">
        <NumericInput
          value={axis.start}
          min={minimum}
          max={maximum}
          onChange={(start) => onChange({ ...axis, start })}
          accessibilityLabel={`${title} sweep start`}
        />
        <Text variant="label" tone="secondary">
          to
        </Text>
        <NumericInput
          value={axis.stop}
          min={minimum}
          max={maximum}
          onChange={(stop) => onChange({ ...axis, stop })}
          accessibilityLabel={`${title} sweep stop`}
        />
        <Text variant="label" tone="secondary">
          in
        </Text>
        <NumericInput
          value={axis.points}
          min={2}
          max={1000}
          onChange={(points) => onChange({ ...axis, points: Math.round(points) })}
          accessibilityLabel={`${title} sweep point count`}
        />
        <Text variant="label" tone="secondary">
          points
        </Text>
      </Stack>
    </Field>
  );
}
