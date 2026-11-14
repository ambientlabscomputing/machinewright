/**
 * Whole-assembly STEP/STL export. Every evaluation already writes both files
 * into the project's output directory, so exporting is "ask where, then copy"
 * — instant, and guaranteed to match exactly what the viewport is showing.
 */
import { copyFile } from "../native/BundledAssets";
import { pickSaveFile } from "../native/FilePicker";
import { defaultJoinPath } from "../workspace/Project";
import { assemblyArtifactName, exportStem, type AssemblyFormat } from "./exportModel";

export type AssemblyExportResult =
  | { readonly kind: "saved"; readonly path: string }
  | { readonly kind: "cancelled" };

export interface AssemblyExportArgs {
  readonly outputDirectory: string;
  readonly graphDigest: string;
  readonly projectId: string;
  readonly format: AssemblyFormat;
}

export async function exportAssemblyFile(args: AssemblyExportArgs): Promise<AssemblyExportResult> {
  const source = defaultJoinPath(args.outputDirectory, assemblyArtifactName(args.graphDigest, args.format));
  const destination = await pickSaveFile(`${exportStem(args.projectId)}.${args.format}`);
  if (destination === null) return { kind: "cancelled" };
  try {
    await copyFile(source, destination);
  } catch (error) {
    throw new Error(
      `Could not export the ${args.format.toUpperCase()} file (${String(error)}). ` +
        "Wait for the current evaluation to finish, then try again.",
    );
  }
  return { kind: "saved", path: destination };
}
