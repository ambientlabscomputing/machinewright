/**
 * B.6: the native design-system component gallery (RFD-19 "Enforcing the
 * design language": "Maintain a component gallery covering default,
 * hover, pressed, selected, focused, disabled, loading, error, and
 * read-only states, plus dense tables and inspector forms" — an explicit
 * M1 deliverable, not decoration).
 *
 * Every control here is *live*, not a static swatch: hover/press/focus
 * states are demonstrated by actually interacting with the real
 * component, which is the only way to honestly show them for controls
 * whose hover/press styling only exists at interaction time (Button,
 * IconButton). Disabled variants are shown side by side with their
 * enabled counterparts for direct comparison.
 */
import { useState, type ReactNode } from "react";
import { ScrollView } from "react-native";
import { Text } from "../native/Text";
import { Stack } from "../native/Stack";
import { Panel, type PanelSurface } from "../native/Panel";
import { Button } from "../native/Button";
import { IconButton } from "../native/IconButton";
import { StatusBadge, type StatusTone } from "../native/StatusBadge";
import { Field } from "../native/Field";
import { NumericInput } from "../native/NumericInput";
import { Slider } from "../native/Slider";

function Section({ title, children }: { title: string; children: ReactNode }) {
  return (
    <Stack gap="sm">
      <Text variant="heading">{title}</Text>
      {children}
    </Stack>
  );
}

const STATUS_TONES: readonly StatusTone[] = ["success", "warning", "error", "stale", "pending"];
const PANEL_SURFACES: readonly PanelSurface[] = ["workspace", "panel", "control", "display"];

export function ComponentGallery() {
  const [payload, setPayload] = useState(10);

  return (
    <ScrollView contentContainerStyle={{ padding: 16 }}>
      <Stack gap="xl">
        <Section title="Text — variant × tone">
          <Stack gap="xs">
            {(["body", "label", "heading", "mono"] as const).map((variant) => (
              <Stack key={variant} direction="row" gap="lg">
                {(["primary", "secondary", "action", "selection"] as const).map((tone) => (
                  <Text key={tone} variant={variant} tone={tone}>
                    {variant}/{tone}
                  </Text>
                ))}
              </Stack>
            ))}
            <Text variant="mono" numeric>
              12345.678 (numeric, tabular)
            </Text>
          </Stack>
        </Section>

        <Section title="Button — hover/press it to see those states live">
          <Stack direction="row" gap="md" align="center">
            <Button label="Neutral" onPress={() => {}} />
            <Button label="Action (primary)" tone="action" onPress={() => {}} />
            <Button label="Compact" size="compact" onPress={() => {}} />
            <Button label="Disabled" disabled onPress={() => {}} />
          </Stack>
        </Section>

        <Section title="IconButton — required accessibilityLabel per control">
          <Stack direction="row" gap="sm">
            <IconButton glyph="+" label="Add" onPress={() => {}} />
            <IconButton glyph="×" label="Remove" onPress={() => {}} />
            <IconButton glyph="⚙" label="Settings" disabled onPress={() => {}} />
          </Stack>
        </Section>

        <Section title="StatusBadge — every semantic tone">
          <Stack direction="row" gap="sm" wrap>
            {STATUS_TONES.map((tone) => (
              <StatusBadge key={tone} tone={tone} label={tone} />
            ))}
          </Stack>
        </Section>

        <Section title="Field + NumericInput + Slider — one bound value, two controls">
          <Stack gap="sm">
            <Field label="Payload" hint="Drag the slider or type an exact value — both update the same state.">
              <Stack direction="row" gap="sm" align="center">
                <NumericInput
                  value={payload}
                  onChange={setPayload}
                  unit="kg"
                  min={0}
                  max={40}
                  accessibilityLabel="Payload in kilograms"
                />
                <Stack flex={1}>
                  <Slider
                    value={payload}
                    min={0}
                    max={40}
                    onChange={(value: number) => setPayload(Math.round(value))}
                    accessibilityLabel="Payload in kilograms"
                  />
                </Stack>
              </Stack>
            </Field>
            <Field label="Payload (disabled)">
              <NumericInput value={payload} onChange={() => {}} unit="kg" disabled accessibilityLabel="Payload (disabled)" />
            </Field>
          </Stack>
        </Section>

        <Section title="Panel — every surface token">
          <Stack direction="row" gap="sm" wrap>
            {PANEL_SURFACES.map((surface) => (
              <Panel key={surface} surface={surface} bordered>
                <Text tone={surface === "display" ? "inverse" : "primary"}>{surface}</Text>
              </Panel>
            ))}
            <Panel surface="control" elevated>
              <Text>control, elevated</Text>
            </Panel>
          </Stack>
        </Section>

        <Section title="Dense inspector row (composition demo)">
          <Panel surface="panel" bordered>
            <Stack direction="row" gap="md" align="center" justify="space-between">
              <Text variant="label">base_plate</Text>
              <Field label="Height">
                <NumericInput value={2} onChange={() => {}} unit="mm" accessibilityLabel="Height in millimeters" />
              </Field>
              <StatusBadge tone="success" label="valid" />
            </Stack>
          </Panel>
        </Section>
      </Stack>
    </ScrollView>
  );
}
