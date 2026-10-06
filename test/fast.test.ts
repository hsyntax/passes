import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { cleanup, events, launch, stage, timeout, workspace } from "./helpers.ts";

afterEach(cleanup);

describe("runner fast mode", () => {
  test(
    "requests fast mode for every supported stage across layers and keeps reasoning effort",
    async () => {
      const ws = workspace();
      const models = [
        "priority-model",
        "fast-model",
        "legacy-model",
        "standard-model",
        "unknown-model",
      ];
      ws.env.PASSES_TEST_MODELS = JSON.stringify(models);
      ws.env.PASSES_TEST_MODEL_TIERS = JSON.stringify({
        "priority-model": { serviceTiers: [{ id: "priority", name: "Fast", description: "" }] },
        "fast-model": { serviceTiers: [{ id: "fast", name: "Fast", description: "" }] },
        "legacy-model": { serviceTiers: [], additionalSpeedTiers: ["fast"] },
        "standard-model": { serviceTiers: [{ id: "standard", name: "Standard", description: "" }] },
      });
      for (const [index, model] of [...models, models[0]!].entries()) {
        stage(ws, `stage-${index}.md`, { model, effort: "high", step: index % 2 });
      }
      const result = await launch(ws, ["run", "stages", "--fast", "--scope", "pr", "--verbose"])
        .result;
      expect(result.code).toBe(0);
      const starts = events(ws).filter((event) => event.kind === "start");
      expect(starts).toHaveLength(6);
      for (const start of starts) {
        const args = start.args ?? [];
        const model = args[args.indexOf("--model") + 1];
        const supported = ["priority-model", "fast-model", "legacy-model"].includes(model ?? "");
        const configs = args.flatMap((arg, index) => (arg === "-c" ? [args[index + 1]] : []));
        expect(configs).toContain('model_reasoning_effort="high"');
        expect(configs.includes('service_tier="fast"')).toBe(supported);
        expect(args.includes("fast_mode")).toBe(supported);
        expect(start.prompt).toStartWith("Scope: pr\n\n");
      }
      expect(events(ws).find((event) => event.kind === "app-server")?.args).toContain("fast_mode");
      expect(result.stdout).toContain("priority-model: fast mode requested.");
      expect(result.stdout).toContain(
        "standard-model: fast mode not advertised; using Codex defaults.",
      );
      expect(result.stdout).toContain(
        "unknown-model: fast mode not advertised; using Codex defaults.",
      );
      const path = /^Log: (.+)$/m.exec(result.stdout)?.[1];
      expect(path).toBeDefined();
      expect(readFileSync(path!, "utf8")).toContain("priority-model: fast mode requested.");
    },
    timeout,
  );

  test(
    "preserves Codex defaults when --fast is omitted even if fast is supported",
    async () => {
      const ws = workspace();
      ws.env.PASSES_TEST_MODEL_TIERS = JSON.stringify({
        "mock-model": { serviceTiers: [{ id: "priority" }] },
      });
      stage(ws, "stage.md");
      const result = await launch(ws).result;
      expect(result.code).toBe(0);
      const invocations = events(ws).filter(
        (event) => event.kind === "start" || event.kind === "app-server",
      );
      expect(invocations).toHaveLength(2);
      for (const invocation of invocations) {
        expect(
          invocation.args?.some((arg) => arg.startsWith("service_tier=") || arg === "fast_mode"),
        ).toBe(false);
      }
      expect(result.output).not.toContain("fast mode requested");
    },
    timeout,
  );

  test(
    "finds fast support on later catalog pages",
    async () => {
      const ws = workspace();
      ws.env.PASSES_TEST_CATALOG_MODE = "paginated";
      ws.env.PASSES_TEST_MODEL_TIERS = JSON.stringify({
        "mock-model": { additionalSpeedTiers: ["fast"] },
      });
      stage(ws, "stage.md");
      const result = await launch(ws, ["run", "stages", "--fast"]).result;
      expect(result.code).toBe(0);
      expect(events(ws).some((event) => event.cursor === "page-2")).toBe(true);
      expect(events(ws).find((event) => event.kind === "start")?.args).toContain(
        'service_tier="fast"',
      );
    },
    timeout,
  );

  test(
    "rejects malformed tier metadata before executing stages",
    async () => {
      const ws = workspace();
      ws.env.PASSES_TEST_MODEL_TIERS = JSON.stringify({ "mock-model": { serviceTiers: "fast" } });
      stage(ws, "stage.md");
      const result = await launch(ws, ["run", "stages", "--fast"]).result;
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("serviceTiers");
      expect(events(ws).some((event) => event.kind === "start")).toBe(false);
    },
    timeout,
  );

  test(
    "does not retry a failed fast stage",
    async () => {
      const ws = workspace();
      ws.env.PASSES_TEST_MODEL_TIERS = JSON.stringify({
        "mock-model": { serviceTiers: [{ id: "priority" }] },
      });
      stage(ws, "stage.md", { prompt: 'fixture:{"id":"failure","exitCode":17}\n' });
      const result = await launch(ws, ["run", "stages", "--fast"]).result;
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("exit code 17");
      expect(events(ws).filter((event) => event.kind === "start")).toHaveLength(1);
    },
    timeout,
  );

  test.each([
    { args: ["run", "stages", "--fast", "--fast"], diagnostic: "only once" },
    { args: ["validate", "stages", "--fast"], diagnostic: "only supported by run" },
  ])(
    "rejects invalid fast usage: $args",
    async ({ args, diagnostic }) => {
      const ws = workspace();
      stage(ws, "stage.md");
      const result = await launch(ws, args).result;
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(diagnostic);
      expect(events(ws)).toEqual([]);
    },
    timeout,
  );
});
