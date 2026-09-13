/**
 * Project discovery: reads `machinewright.toml` and validates it against the
 * same shape as Python's `ProjectConfig` (src/machinewright/project.py),
 * without re-implementing Python's path/existence validation — the worker
 * evaluates against the real project root and will surface its own
 * diagnostics for a broken project. This module's job is only to identify
 * *which* project is open, which template(s) it declares, and where its
 * worker/environment live, before any evaluation happens.
 *
 * Environment *resolution* (creating/repairing a virtualenv) is explicitly
 * out of scope for M2 — see RFD-19's "Missing environment" failure-behavior
 * bullet: the application must explain an unresolved interpreter/dependency,
 * not silently substitute a different one. This module only detects and
 * reports; it never repairs.
 */
import { parse as parseToml } from "smol-toml";

export interface TemplateEntry {
  readonly id: string;
  readonly version: string;
  readonly callable: string;
  readonly cacheable: boolean;
}

export interface ProjectConfig {
  readonly projectId: string;
  readonly environmentLock: string;
  readonly templates: readonly TemplateEntry[];
  readonly assets: readonly string[];
  readonly inputConfigurations: readonly string[];
}

export interface ProjectHandle {
  readonly rootPath: string;
  readonly config: ProjectConfig;
  /** project-root-relative convention: `.venv/bin/machinewright-worker`. */
  readonly workerExecutablePath: string;
  readonly lspExecutablePath: string;
}

export class ProjectDiscoveryError extends Error {
  constructor(
    message: string,
    readonly reason: "missing_manifest" | "invalid_manifest",
  ) {
    super(message);
    this.name = "ProjectDiscoveryError";
  }
}

export interface ProjectDiscoveryPorts {
  readonly readTextFile: (path: string) => Promise<string>;
  readonly joinPath: (root: string, ...segments: string[]) => string;
}

const defaultJoinPath = (root: string, ...segments: string[]): string =>
  [root.replace(/\/+$/, ""), ...segments].join("/");

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function parseTemplateEntry(value: unknown, index: number): TemplateEntry {
  if (!isRecord(value)) {
    throw new ProjectDiscoveryError(`templates[${index}] must be a table`, "invalid_manifest");
  }
  const { id, version, callable, cacheable } = value;
  if (typeof id !== "string" || typeof version !== "string" || typeof callable !== "string") {
    throw new ProjectDiscoveryError(
      `templates[${index}] must declare string id, version, and callable`,
      "invalid_manifest",
    );
  }
  return { id, version, callable, cacheable: cacheable === true };
}

function parseStringArray(value: unknown, field: string): readonly string[] {
  if (value === undefined) return [];
  if (!Array.isArray(value) || !value.every((item) => typeof item === "string")) {
    throw new ProjectDiscoveryError(`${field} must be an array of strings`, "invalid_manifest");
  }
  return value;
}

export function parseProjectConfig(tomlSource: string): ProjectConfig {
  let parsed: unknown;
  try {
    parsed = parseToml(tomlSource);
  } catch (error) {
    throw new ProjectDiscoveryError(
      `machinewright.toml is not valid TOML: ${String(error)}`,
      "invalid_manifest",
    );
  }
  if (!isRecord(parsed)) {
    throw new ProjectDiscoveryError("machinewright.toml must contain a table", "invalid_manifest");
  }
  const { project_id: projectId, environment_lock: environmentLock, templates, assets, input_configurations: inputConfigurations } =
    parsed;
  if (typeof projectId !== "string" || projectId.length === 0) {
    throw new ProjectDiscoveryError("machinewright.toml is missing project_id", "invalid_manifest");
  }
  if (typeof environmentLock !== "string" || environmentLock.length === 0) {
    throw new ProjectDiscoveryError("machinewright.toml is missing environment_lock", "invalid_manifest");
  }
  const templateEntries = Array.isArray(templates) ? templates.map(parseTemplateEntry) : [];
  const keys = new Set<string>();
  for (const entry of templateEntries) {
    const key = `${entry.id}@${entry.version}`;
    if (keys.has(key)) {
      throw new ProjectDiscoveryError(`duplicate template id/version pair: ${key}`, "invalid_manifest");
    }
    keys.add(key);
  }
  return {
    projectId,
    environmentLock,
    templates: templateEntries,
    assets: parseStringArray(assets, "assets"),
    inputConfigurations: parseStringArray(inputConfigurations, "input_configurations"),
  };
}

const MANIFEST_FILE = "machinewright.toml";

export async function openProject(
  rootPath: string,
  ports: ProjectDiscoveryPorts,
): Promise<ProjectHandle> {
  const joinPath = ports.joinPath;
  let tomlSource: string;
  try {
    tomlSource = await ports.readTextFile(joinPath(rootPath, MANIFEST_FILE));
  } catch (error) {
    throw new ProjectDiscoveryError(
      `no ${MANIFEST_FILE} found at ${rootPath}: ${String(error)}`,
      "missing_manifest",
    );
  }
  const config = parseProjectConfig(tomlSource);
  return {
    rootPath,
    config,
    workerExecutablePath: joinPath(rootPath, ".venv", "bin", "machinewright-worker"),
    lspExecutablePath: joinPath(rootPath, ".venv", "bin", "pylsp"),
  };
}

export { defaultJoinPath };
