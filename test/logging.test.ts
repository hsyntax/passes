import { afterEach, describe, expect, test } from "bun:test";
import {
  existsSync,
  readFileSync,
  readdirSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative } from "node:path";
import {
  cleanup,
  directive,
  events,
  expectFixtureStopped,
  launch,
  stage,
  timeout,
  waitFor,
  workspace,
} from "./helpers.ts";

afterEach(cleanup);

function logPath(output: string): string {
  const path = /^Log: (.+)$/m.exec(output)?.[1];
  if (!path) throw new Error(`No log path in output: ${output}`);
  return path;
}

describe("run logging", () => {
  test(
    "stores labeled output outside the checkout with concise terminal progress",
    async () => {
      const ws = workspace({ nested: true });
      stage(ws, "stage.md", {
        name: "Example stage",
        prompt: directive("output", {
          stdout: "héllo 🌍\npartial stdout",
          stderr: "échec 🌍\npartial stderr",
          outputBytewise: true,
        }),
      });
      const result = await launch(ws).result;
      expect(result.code).toBe(0);
      const path = logPath(result.stdout);
      expect(isAbsolute(path)).toBe(true);
      expect(relative(ws.repo, path)).toStartWith("..");
      expect(path).toStartWith(join(ws.env.HOME!, ".local/state/passes/runs"));
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const log = readFileSync(path, "utf8");
      expect(log).toContain(`Working directory: ${ws.cwd}`);
      for (const text of [
        "[Example stage] héllo 🌍",
        "[Example stage] partial stdout",
        "[Example stage stderr] échec 🌍",
        "[Example stage stderr] partial stderr",
      ]) {
        expect(log).toContain(text);
        expect(result.output).not.toContain(text);
      }
      expect(result.stdout).toContain("Example stage: starting");
      expect(result.stdout).toContain("Example stage: completed");
      expect(result.stdout).toContain("Finished: 1 stages completed");
      expect(log).toContain("Finished: 1 stages completed");
      expect(readdirSync(ws.cwd)).toEqual(["stages"]);
    },
    timeout,
  );

  test(
    "writes output during a run and preserves partial lines on cancellation",
    async () => {
      const ws = workspace();
      stage(ws, "stage.md", {
        prompt: directive("hold", { stdout: "live marker\npartial at cancel", hold: true }),
      });
      const execution = launch(ws);
      await waitFor(() => /^Log: /m.test(execution.stdout), "log path");
      const path = logPath(execution.stdout);
      await waitFor(() => readFileSync(path, "utf8").includes("live marker"), "live file output");
      await waitFor(
        () => events(ws).some((event) => event.kind === "ready" && event.id === "hold"),
        "partial output written before cancellation",
      );
      expect(execution.stdout).not.toContain("live marker");
      execution.child.kill("SIGTERM");
      const result = await execution.result;
      expect(result.code).toBe(143);
      expect(readFileSync(path, "utf8")).toContain("partial at cancel");
      expect(readFileSync(path, "utf8")).toContain("cancelled");
      expect(result.stderr).toContain("Recent output:");
      expect(result.stderr).toContain("partial at cancel");
      await expectFixtureStopped(ws);
    },
    timeout,
  );

  test(
    "shows a bounded failure excerpt while retaining the full output",
    async () => {
      const ws = workspace();
      const lines = Array.from({ length: 100 }, (_, index) => `diagnostic ${index}`).join("\n");
      stage(ws, "stage.md", { prompt: directive("fail", { stderr: lines, exitCode: 17 }) });
      const result = await launch(ws).result;
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("exit code 17");
      expect(result.stderr).toContain("Recent output:");
      expect(result.stderr).toContain("diagnostic 99");
      expect(result.stderr).not.toContain("diagnostic 0\n");
      expect(result.stderr.length).toBeLessThan(9_000);
      const log = readFileSync(logPath(result.stdout), "utf8");
      expect(log).toContain("diagnostic 0\n");
      expect(log).toContain("diagnostic 99");
      expect(log).toContain("exit code 17");
    },
    timeout,
  );

  test(
    "verbose streams both channels and still saves the complete log",
    async () => {
      const ws = workspace();
      stage(ws, "stage.md", {
        prompt: directive("verbose", {
          stdout: "live stdout\n",
          stderr: "live stderr\n",
          exitCode: 1,
        }),
      });
      const result = await launch(ws, ["run", "stages", "--verbose"]).result;
      expect(result.code).toBe(1);
      expect(result.stdout).toContain("live stdout");
      expect(result.stderr).toContain("live stderr");
      expect(result.stderr).not.toContain("Recent output:");
      const log = readFileSync(logPath(result.stdout), "utf8");
      expect(log).toContain("live stdout");
      expect(log).toContain("live stderr");
    },
    timeout,
  );

  test(
    "uses XDG_STATE_HOME and keeps distinct logs across runs",
    async () => {
      const ws = workspace();
      ws.env.XDG_STATE_HOME = join(ws.root, "state");
      stage(ws, "stage.md", { prompt: directive("first", { stdout: "first run output\n" }) });
      const first = await launch(ws).result;
      const firstPath = logPath(first.stdout);
      const original = readFileSync(firstPath, "utf8");
      stage(ws, "stage.md", { prompt: directive("second", { stdout: "second run output\n" }) });
      const second = await launch(ws).result;
      expect(first.code).toBe(0);
      expect(second.code).toBe(0);
      expect(firstPath).toStartWith(join(ws.root, "state/passes/runs"));
      expect(logPath(second.stdout)).not.toBe(firstPath);
      expect(original).toContain("first run output");
      const secondLog = readFileSync(logPath(second.stdout), "utf8");
      expect(secondLog).toContain("second run output");
      expect(secondLog).not.toContain("first run output");
      expect(readFileSync(firstPath, "utf8")).toBe(original);
    },
    timeout,
  );

  test.each(["direct", "symlink"])(
    "rejects %s log destinations inside the checkout before starting Codex",
    async (mode) => {
      const ws = workspace({ nested: true });
      stage(ws, "stage.md");
      const destination = mode === "direct" ? ws.repo : join(ws.root, "state-link");
      if (mode === "symlink") symlinkSync(ws.repo, destination);
      ws.env.XDG_STATE_HOME = destination;
      const result = await launch(ws).result;
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("outside");
      expect(events(ws)).toEqual([]);
      expect(existsSync(join(ws.repo, "passes"))).toBe(false);
    },
    timeout,
  );

  test(
    "fails before starting Codex when the log cannot be created",
    async () => {
      const ws = workspace();
      const blocked = join(ws.root, "blocked");
      writeFileSync(blocked, "file, not directory");
      ws.env.XDG_STATE_HOME = blocked;
      stage(ws, "stage.md");
      const result = await launch(ws).result;
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Could not create run log");
      expect(events(ws)).toEqual([]);
    },
    timeout,
  );

  test(
    "retains preflight failure diagnostics in the log",
    async () => {
      const ws = workspace();
      stage(ws, "stage.md", { model: "missing-model" });
      const result = await launch(ws).result;
      expect(result.code).toBe(1);
      expect(readFileSync(logPath(result.stdout), "utf8")).toContain("missing-model");
      expect(result.stderr).not.toContain("Recent output:");
      expect(events(ws).some((event) => event.kind === "start")).toBe(false);
    },
    timeout,
  );

  test(
    "validation and informational commands do not create logs",
    async () => {
      const ws = workspace({ git: false, codex: false });
      stage(ws, "stage.md");
      for (const args of [["validate", "stages"], ["--help"], ["--version"]]) {
        const result = await launch(ws, args).result;
        expect(result.code).toBe(0);
        expect(result.output).not.toContain("Log: ");
      }
      expect(existsSync(join(ws.env.HOME!, ".local/state/passes"))).toBe(false);
    },
    timeout,
  );
});
