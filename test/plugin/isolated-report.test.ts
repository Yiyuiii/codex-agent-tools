import {
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  unlink,
  writeFile,
} from "node:fs/promises";
import os from "node:os";
import path from "node:path";

import { afterEach, describe, expect, it, vi } from "vitest";

import {
  canonicalizeIsolatedReportPaths,
  IsolatedReportError,
  parseIsolatedReportArguments,
  synchronizeIsolatedReport,
  type IsolatedReportFileSystem,
} from "../../src/plugin/isolated-report.js";

const roots: string[] = [];

async function temporaryReport(
  contents = "committed report\n",
): Promise<{ reportPath: string; root: string }> {
  const root = await mkdtemp(
    path.join(os.tmpdir(), "codex-isolated-report-test-"),
  );
  roots.push(root);
  const reportPath = path.join(root, "plugin-isolated-state.md");
  await writeFile(reportPath, contents, "utf8");
  return { reportPath, root };
}

function nativeFileSystem(events: string[] = []): IsolatedReportFileSystem {
  return {
    async readFile(filePath) {
      events.push("read");
      return readFile(filePath);
    },
    async writeFile(filePath, contents, options) {
      events.push("write");
      await writeFile(filePath, contents, options);
    },
    async rename(from, to) {
      events.push("rename");
      await rename(from, to);
    },
    async unlink(filePath) {
      events.push("unlink");
      await unlink(filePath);
    },
  };
}

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(
    roots.splice(0).map((root) => rm(root, { recursive: true, force: true })),
  );
});

describe("isolated plugin report synchronization", () => {
  it("makes ephemeral arg0 shim presence and random directory names irrelevant", () => {
    const firstRun = [
      "tmp/arg0/codex-arg0-a1/.lock",
      "tmp/arg0/codex-arg0-a1/apply_patch.bat",
      "tmp/arg0/codex-arg0-a1/applypatch.bat",
    ];
    const secondRun = [
      "tmp/arg0/codex-arg0-b2/applypatch.bat",
      "tmp/arg0/codex-arg0-b2/.lock",
    ];

    expect(canonicalizeIsolatedReportPaths(firstRun)).toEqual([]);
    expect(canonicalizeIsolatedReportPaths(secondRun)).toEqual([]);
    expect(canonicalizeIsolatedReportPaths([])).toEqual([]);
  });

  it("excludes only the three exact Codex CLI arg0 shim names", () => {
    expect(
      canonicalizeIsolatedReportPaths([
        "tmp/arg0/codex-arg0-fixed/.lock",
        "tmp/arg0/codex-arg0-fixed/apply_patch.bat",
        "tmp/arg0/codex-arg0-fixed/applypatch.bat",
      ]),
    ).toEqual([]);
  });

  it("preserves neighboring files and stable config and plugin paths", () => {
    expect(
      canonicalizeIsolatedReportPaths([
        "tmp/arg0/codex-arg0-random/subdir/apply_patch.bat",
        "plugins/cache/example/plugin.json",
        "config.toml",
        "tmp/arg0/codex-arg0-random/.lock.backup",
        "tmp/arg0/codex-other/apply_patch.bat",
        "tmp/arg0/codex-arg0-other/keep.txt",
        "plugins/cache/example/plugin.json",
        "config.toml",
      ]),
    ).toEqual([
      "config.toml",
      "plugins/cache/example/plugin.json",
      "tmp/arg0/<ephemeral>/.lock.backup",
      "tmp/arg0/<ephemeral>/keep.txt",
      "tmp/arg0/<ephemeral>/subdir/apply_patch.bat",
      "tmp/arg0/codex-other/apply_patch.bat",
    ]);
  });

  it("wires the acceptance script to the helper after the complete lifecycle", async () => {
    const script = await readFile(
      path.resolve("scripts/plugin-isolated-acceptance.mjs"),
      "utf8",
    );
    const normalizedScript = script.replaceAll("\r\n", "\n");

    expect(normalizedScript).toContain(
      'from "../dist/plugin-isolated-report.js"',
    );
    expect(normalizedScript).toContain(
      "parseIsolatedReportArguments(\n  process.argv.slice(2),\n)",
    );
    expect(normalizedScript).not.toMatch(/writeFile\s*\(\s*reportPath\s*,/u);
    expect(
      normalizedScript.indexOf("synchronizeIsolatedReport({"),
    ).toBeGreaterThan(
      normalizedScript.indexOf(
        'runCodex(["plugin", "marketplace", "remove", marketplace])',
      ),
    );
  });

  it("accepts only the default update mode or --check-report", () => {
    expect(parseIsolatedReportArguments([])).toEqual({ mode: "update" });
    expect(parseIsolatedReportArguments(["--check-report"])).toEqual({
      mode: "check",
    });

    for (const args of [
      ["--update-report"],
      ["--check-report", "--check-report"],
      ["--check-report=true"],
      ["--unknown"],
    ]) {
      expect(() => parseIsolatedReportArguments(args)).toThrowError(
        new IsolatedReportError("invalid_arguments"),
      );
    }
  });

  it("fails closed when an untyped caller supplies an unsupported mode", async () => {
    const { reportPath } = await temporaryReport("old\n");
    const render = vi.fn(() => "new\n");

    await expect(
      synchronizeIsolatedReport({
        mode: "overwrite" as "check",
        reportPath,
        render,
      }),
    ).rejects.toEqual(new IsolatedReportError("invalid_arguments"));

    expect(render).not.toHaveBeenCalled();
    expect(await readFile(reportPath, "utf8")).toBe("old\n");
  });

  it("checks byte-identical rendered content without any write", async () => {
    const { reportPath } = await temporaryReport("same\r\nbytes\n");
    const events: string[] = [];
    const render = vi.fn(async () => {
      events.push("render");
      return "same\r\nbytes\n";
    });

    await expect(
      synchronizeIsolatedReport({
        mode: "check",
        reportPath,
        render,
        fileSystem: nativeFileSystem(events),
      }),
    ).resolves.toEqual({ status: "unchanged" });

    expect(render).toHaveBeenCalledOnce();
    expect(events).toEqual(["render", "read"]);
    expect(await readFile(reportPath, "utf8")).toBe("same\r\nbytes\n");
  });

  it("fails check mode on byte drift with a fixed error and never writes", async () => {
    const secret = "secret-new-report-body";
    const { reportPath, root } = await temporaryReport("committed\n");
    const events: string[] = [];

    const promise = synchronizeIsolatedReport({
      mode: "check",
      reportPath,
      render: () => `drifted ${secret}\n`,
      fileSystem: nativeFileSystem(events),
    });

    await expect(promise).rejects.toMatchObject({
      name: "IsolatedReportError",
      code: "report_drift",
      message: "Isolated plugin report differs from committed report",
    });
    await expect(promise).rejects.not.toThrow(secret);
    expect(events).toEqual(["read"]);
    expect(await readFile(reportPath, "utf8")).toBe("committed\n");
    expect(await readdir(root)).toEqual(["plugin-isolated-state.md"]);
  });

  it("atomically replaces the report only after rendering and staging complete", async () => {
    const { reportPath, root } = await temporaryReport("old\n");
    const events: string[] = [];
    const fileSystem = nativeFileSystem(events);

    await expect(
      synchronizeIsolatedReport({
        mode: "update",
        reportPath,
        render: async () => {
          events.push("render-start");
          await Promise.resolve();
          events.push("render-complete");
          return "complete new report\n";
        },
        fileSystem,
        createNonce: () => "fixed-nonce",
      }),
    ).resolves.toEqual({ status: "updated" });

    expect(events).toEqual([
      "render-start",
      "render-complete",
      "write",
      "rename",
    ]);
    expect(await readFile(reportPath, "utf8")).toBe("complete new report\n");
    expect(await readdir(root)).toEqual(["plugin-isolated-state.md"]);
  });

  it("does not touch the existing report when rendering fails", async () => {
    const secret = "renderer leaked a secret";
    const { reportPath, root } = await temporaryReport("old\n");
    const events: string[] = [];

    const promise = synchronizeIsolatedReport({
      mode: "update",
      reportPath,
      render: () => {
        throw new Error(secret);
      },
      fileSystem: nativeFileSystem(events),
    });

    await expect(promise).rejects.toMatchObject({
      code: "render_failed",
      message: "Isolated plugin report rendering failed",
    });
    await expect(promise).rejects.not.toThrow(secret);
    expect(events).toEqual([]);
    expect(await readFile(reportPath, "utf8")).toBe("old\n");
    expect(await readdir(root)).toEqual(["plugin-isolated-state.md"]);
  });

  it("cleans a partial staging file and preserves the report on write failure", async () => {
    const secret = "write failure with secret path";
    const { reportPath, root } = await temporaryReport("old\n");
    const fileSystem = nativeFileSystem();
    fileSystem.writeFile = async (filePath) => {
      await writeFile(filePath, "partial", {
        encoding: "utf8",
        flag: "wx",
      });
      throw new Error(secret);
    };

    const promise = synchronizeIsolatedReport({
      mode: "update",
      reportPath,
      render: () => "new\n",
      fileSystem,
      createNonce: () => "write-failure",
    });

    await expect(promise).rejects.toMatchObject({
      code: "update_failed",
      message: "Isolated plugin report update failed",
    });
    await expect(promise).rejects.not.toThrow(secret);
    expect(await readFile(reportPath, "utf8")).toBe("old\n");
    expect(await readdir(root)).toEqual(["plugin-isolated-state.md"]);
  });

  it("preserves the existing report and removes staging on rename failure", async () => {
    const { reportPath, root } = await temporaryReport("old\n");
    const fileSystem = nativeFileSystem();
    fileSystem.rename = async () => {
      throw new Error("rename secret");
    };

    await expect(
      synchronizeIsolatedReport({
        mode: "update",
        reportPath,
        render: () => "new\n",
        fileSystem,
        createNonce: () => "rename-failure",
      }),
    ).rejects.toMatchObject({
      code: "update_failed",
      message: "Isolated plugin report update failed",
    });
    expect(await readFile(reportPath, "utf8")).toBe("old\n");
    expect(await readdir(root)).toEqual(["plugin-isolated-state.md"]);
  });

  it("never removes a pre-existing staging collision it does not own", async () => {
    const { reportPath, root } = await temporaryReport("old\n");
    const collision = path.join(
      root,
      ".plugin-isolated-state.md.collision.tmp",
    );
    await writeFile(collision, "other owner\n", {
      encoding: "utf8",
      flag: "wx",
    });

    await expect(
      synchronizeIsolatedReport({
        mode: "update",
        reportPath,
        render: () => "new\n",
        createNonce: () => "collision",
      }),
    ).rejects.toEqual(new IsolatedReportError("update_failed"));

    expect(await readFile(reportPath, "utf8")).toBe("old\n");
    expect(await readFile(collision, "utf8")).toBe("other owner\n");
  });
});
