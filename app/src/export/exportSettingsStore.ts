/**
 * Read-modify-write persistence of `.machinewright/export-settings.json`, shared by
 * the Export dialog (part settings) and the 3D Print tab (printer settings) so one
 * never clobbers the section the other owns.
 */
import { readTextFile, writeTextFileAtomically } from "../native/BundledAssets";
import { exportSettingsPath, parseExportSettings, type PersistedExportSettings } from "./exportModel";

export async function loadExportSettings(projectRoot: string): Promise<PersistedExportSettings> {
  const text = await readTextFile(exportSettingsPath(projectRoot)).catch(() => "");
  return parseExportSettings(text);
}

export async function saveExportSettings(projectRoot: string, patch: Partial<PersistedExportSettings>): Promise<void> {
  const current = await loadExportSettings(projectRoot);
  const next: PersistedExportSettings = { ...current, ...patch };
  await writeTextFileAtomically(exportSettingsPath(projectRoot), JSON.stringify(next, null, 2) + "\n");
}
