import { describe, expect, it, vi } from "vitest";
import { ExportCoordinator, type ExportJobInput } from "../../src/export/ExportCoordinator";
import type { WorkerTransport } from "../../src/evaluator/WorkerTransport";

const input: ExportJobInput = {
  projectRoot: "/p",
  templateId: "t",
  templateVersion: "1",
  inputsJson: new Uint8Array(),
  overlays: [],
  environmentDigest: "",
  kind: "print_plan",
  outputDirectory: "",
  options: {},
  basename: "x",
};

function transport() {
  const send = vi.fn(async () => {});
  const t = { send, onEvent: () => () => {}, onExit: () => () => {} } as unknown as WorkerTransport;
  return { t, send };
}

describe("ExportCoordinator capability check", () => {
  it("fails fast, without contacting the worker, when it lacks export support", async () => {
    const { t, send } = transport();
    const coordinator = new ExportCoordinator({ transport: t, capabilities: () => ["progress.v1"] });
    const outcome = await coordinator.run(input).outcome;
    expect(outcome).toMatchObject({ kind: "failed", code: "export.unsupported_worker" });
    expect(send).not.toHaveBeenCalled();
  });

  it("sends the request when the worker advertises export support or capabilities are not yet known", () => {
    for (const capabilities of [() => ["export_jobs.v1"], () => []]) {
      const { t, send } = transport();
      new ExportCoordinator({ transport: t, capabilities }).run(input);
      expect(send).toHaveBeenCalledTimes(1);
    }
  });
});
