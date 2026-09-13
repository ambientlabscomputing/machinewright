import { describe, expect, it } from "vitest";
import { defaultJoinPath, openProject, parseProjectConfig, ProjectDiscoveryError } from "../../src/workspace/Project";

const VALID_TOML = `
project_id = "jog-machine"
environment_lock = ".venv/lock.json"

[[templates]]
id = "machinewright.reference.simple"
version = "1.0.0"
callable = "reference_project:simple"
cacheable = true
`;

describe("parseProjectConfig", () => {
  it("parses a valid machinewright.toml into a ProjectConfig", () => {
    const config = parseProjectConfig(VALID_TOML);
    expect(config).toMatchObject({
      projectId: "jog-machine",
      environmentLock: ".venv/lock.json",
      templates: [{ id: "machinewright.reference.simple", version: "1.0.0", callable: "reference_project:simple", cacheable: true }],
    });
  });

  it("rejects a manifest missing project_id", () => {
    expect(() => parseProjectConfig(`environment_lock = ".venv/lock.json"`)).toThrow(ProjectDiscoveryError);
  });

  it("rejects a manifest missing environment_lock", () => {
    expect(() => parseProjectConfig(`project_id = "x"`)).toThrow(ProjectDiscoveryError);
  });

  it("rejects duplicate template id/version pairs, mirroring project.py's unique_templates validator", () => {
    const toml = `
project_id = "x"
environment_lock = ".venv/lock.json"

[[templates]]
id = "a"
version = "1.0.0"
callable = "x:a"

[[templates]]
id = "a"
version = "1.0.0"
callable = "x:a"
`;
    expect(() => parseProjectConfig(toml)).toThrow(/duplicate/);
  });

  it("defaults cacheable to false and assets/input_configurations to empty arrays", () => {
    const config = parseProjectConfig(`
project_id = "x"
environment_lock = ".venv/lock.json"

[[templates]]
id = "a"
version = "1.0.0"
callable = "x:a"
`);
    expect(config.templates[0]?.cacheable).toBe(false);
    expect(config.assets).toEqual([]);
    expect(config.inputConfigurations).toEqual([]);
  });
});

describe("openProject", () => {
  it("reads machinewright.toml at the project root and resolves conventional executable paths", async () => {
    const handle = await openProject("/tmp/jog-machine", {
      readTextFile: async (path) => {
        expect(path).toBe("/tmp/jog-machine/machinewright.toml");
        return VALID_TOML;
      },
      joinPath: defaultJoinPath,
    });

    expect(handle.rootPath).toBe("/tmp/jog-machine");
    expect(handle.config.projectId).toBe("jog-machine");
    expect(handle.workerExecutablePath).toBe("/tmp/jog-machine/.venv/bin/machinewright-worker");
    expect(handle.lspExecutablePath).toBe("/tmp/jog-machine/.venv/bin/pylsp");
  });

  it("surfaces a missing_manifest error when machinewright.toml cannot be read, detection only — never a repair attempt", async () => {
    await expect(
      openProject("/tmp/not-a-project", {
        readTextFile: async () => {
          throw new Error("ENOENT");
        },
        joinPath: defaultJoinPath,
      }),
    ).rejects.toMatchObject({ reason: "missing_manifest" });
  });
});
