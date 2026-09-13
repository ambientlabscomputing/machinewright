/**
 * The real "Open Project" entry point: native directory picker ->
 * `Project.openProject`. This is what replaces every M1 spike's hardcoded
 * `REPO_ROOT = "/Users/jose/ambient_labs/jog/machinewright"` constant with
 * an actual user-driven flow (RFD-19 M2: "project/workspace shell").
 *
 * Returns `null` if the user cancelled the picker — distinct from
 * `openProject` throwing `ProjectDiscoveryError`, which means a directory
 * *was* chosen but isn't a valid Machinewright project.
 */
import { pickProjectDirectory } from "../native/FilePicker";
import { readTextFile } from "../native/BundledAssets";
import { defaultJoinPath, openProject, type ProjectHandle } from "./Project";

export async function openProjectFromPicker(): Promise<ProjectHandle | null> {
  const rootPath = await pickProjectDirectory();
  if (rootPath === null) return null;
  return openProject(rootPath, { readTextFile, joinPath: defaultJoinPath });
}
