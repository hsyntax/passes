import { afterEach, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { cleanup, directive, events, launch, stage, timeout, workspace } from "./helpers.ts";

afterEach(cleanup);

describe("runner fast mode", () => {
  test(
    "requests fast mode for every supported stage across layers and keeps reasoning effort",
    async () => {
      const ws = workspace();
      // Expected selections come from the requested stages, not the observed argv.
      const selections = [
        { model: "priority-model", fast: true },
        { model: "fast-model", fast: true },
        { model: "legacy-model", fast: true },
        { model: "standard-model", fast: false },
        { model: "unadvertised-model", fast: false },
        { model: "priority-model", fast: true },
      ];
      ws.env.PASSES_TEST_MODELS = JSON.stringify([
        ...new Set(selections.map(({ model }) => model)),
      ]);
      ws.env.PASSES_TEST_MODEL_TIERS = JSON.stringify({
        "priority-model": { serviceTiers: [{ id: "priority", name: "Fast", description: "" }] },
        "fast-model": { serviceTiers: [{ id: "fast", name: "Fast", description: "" }] },
        "legacy-model": { serviceTiers: [], additionalSpeedTiers: ["fast"] },
        "standard-model": {
          serviceTiers: [{ id: "standard", name: "Standard", description: "" }],
          additionalSpeedTiers: ["fast"],
        },
      });
      for (const [index, { model }] of selections.entries()) {
        stage(ws, `stage-${index}.md`, {
          model,
          effort: "high",
          step: index % 2,
          prompt: `Review stage ${index}.\n`,
        });
      }
      const result = await launch(ws, ["run", "stages", "--fast", "--scope", "pr", "--verbose"])
        .result;
      expect(result.code).toBe(0);
      const starts = events(ws).filter((event) => event.kind === "start");
      expect(starts).toHaveLength(selections.length);
      for (const [index, { model, fast }] of selections.entries()) {
        const matching = starts.filter((start) =>
          start.prompt?.startsWith(`Scope: pr\n\nReview stage ${index}.\n`),
        );
        expect(matching).toHaveLength(1);
        const args = matching[0]?.args ?? [];
        expect(args).toContain("--model");
        expect(args[args.indexOf("--model") + 1]).toBe(model);
        const configs = args.flatMap((arg, index) => (arg === "-c" ? [args[index + 1]] : []));
        const features = args.flatMap((arg, index) =>
          arg === "--enable" ? [args[index + 1]] : [],
        );
        expect(configs).toContain('model_reasoning_effort="high"');
        expect(configs.filter((config) => config?.startsWith("service_tier="))).toEqual(
          fast ? ['service_tier="fast"'] : [],
        );
        expect(features.includes("fast_mode")).toBe(fast);
      }
      expect(events(ws).find((event) => event.kind === "app-server")?.args).toContain("fast_mode");
      expect(result.stdout).toContain("priority-model: fast mode requested.");
      expect(result.stdout).toContain(
        "standard-model: fast mode not advertised; using Codex defaults.",
      );
      expect(result.stdout).toContain(
        "unadvertised-model: fast mode not advertised; using Codex defaults.",
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
      expect(events(ws).filter((event) => event.kind === "start")).toHaveLength(1);
      const invocations = events(ws).filter(
        (event) => event.kind === "start" || event.kind === "app-server",
      );
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
      stage(ws, "stage.md", {
        prompt: directive("failure", {
          exitCode: 17,
          appendFile: { path: "attempts.txt", content: "stage edit\n" },
        }),
      });
      const result = await launch(ws, ["run", "stages", "--fast"]).result;
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("exit code 17");
      expect(events(ws).filter((event) => event.kind === "start")).toHaveLength(1);
      expect(readFileSync(join(ws.cwd, "attempts.txt"), "utf8")).toBe("stage edit\n");
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
