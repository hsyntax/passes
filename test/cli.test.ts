import { afterEach, describe, expect, test } from "bun:test";
import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanup,
  commitInstructions,
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

describe("passes CLI acceptance", () => {
  test(
    "validate prints ordered layers without spawning Codex or requiring a repository",
    async () => {
      const ws = workspace({ git: false, codex: false });
      stage(ws, "later.md", { name: "Final review", step: 8, effort: "high" });
      stage(ws, "first.md", { name: "First pass", step: 0 });
      stage(ws, "peer.md", { name: "Peer pass", step: 0 });
      writeFileSync(join(ws.cwd, "untouched.txt"), "original contents\n");
      const result = await launch(ws, ["validate", "stages"]).result;
      expect(result.code).toBe(0);
      expect(result.output).toMatch(/3 stages/i);
      expect(result.output).toMatch(/2 layers/i);
      expect(result.output).toContain("First pass");
      expect(result.output).toContain("Peer pass");
      expect(result.output).toContain("Final review");
      expect(result.output).toMatch(/step\s+0/i);
      expect(result.output).toMatch(/step\s+8/i);
      expect(result.output.search(/step\s+0/i)).toBeLessThan(result.output.search(/step\s+8/i));
      expect(result.output).toMatch(/concurrent|parallel/i);
      expect(result.output).toMatch(/shared/i);
      expect(events(ws)).toEqual([]);
      expect(readFileSync(join(ws.cwd, "untouched.txt"), "utf8")).toBe("original contents\n");
    },
    timeout,
  );

  test(
    "validate accepts a scope override without resolving it or requiring Git or Codex",
    async () => {
      const ws = workspace({ git: false, codex: false });
      stage(ws, "stage.md", { scope: "frontmatter default" });
      const marker = join(ws.cwd, "scope-injected-marker");
      const scope = `  PR nonexistent; $(: > '${marker}'); \`: > '${marker}'\`  `;
      const result = await launch(ws, ["validate", "stages", "--scope", scope]).result;
      expect(result.code).toBe(0);
      expect(result.output).toMatch(/1 stages/i);
      expect(events(ws)).toEqual([]);
      expect(existsSync(marker)).toBe(false);
    },
    timeout,
  );

  test(
    "run prepends frontmatter scope as the first stdin line while keeping an unscoped stage unchanged",
    async () => {
      const ws = workspace();
      const body = "\n# Literal Markdown\r\n${values}\nBefore → After 🌍\n";
      const scope = "  Review only src/parser  ";
      stage(ws, "scoped.md", { scope, prompt: body });
      const unscoped = stage(ws, "unscoped.md", { step: 1, prompt: directive("unscoped") });
      const result = await launch(ws).result;
      expect(result.code).toBe(0);
      const starts = events(ws).filter((event) => event.kind === "start");
      expect(starts).toHaveLength(2);
      expect(starts[0]?.prompt).toBe(`Scope: ${scope}\n\n${body}\n\n${commitInstructions}\n`);
      expect(starts[1]?.prompt).toBe(`${unscoped}\n\n${commitInstructions}\n`);
      await expectFixtureStopped(ws);
    },
    timeout,
  );

  test(
    "run applies the exact CLI scope to every layer, overriding frontmatter and preserving literal shell text",
    async () => {
      const ws = workspace();
      const marker = join(ws.cwd, "scope-injected-marker");
      const scope = `  commit does-not-exist; $(: > '${marker}'); \`: > '${marker}'\`; \${literal}  `;
      const first = stage(ws, "first.md", {
        scope: "frontmatter scope must be replaced",
        prompt: "First literal stage.\n",
      });
      const second = stage(ws, "second.md", { step: 1, prompt: "Second literal stage.\r\n" });
      const result = await launch(ws, ["run", "stages", "--scope", scope]).result;
      expect(result.code).toBe(0);
      const starts = events(ws).filter((event) => event.kind === "start");
      expect(starts.map((event) => event.prompt)).toEqual(
        [first, second].map((body) => `Scope: ${scope}\n\n${body}\n\n${commitInstructions}\n`),
      );
      expect(existsSync(marker)).toBe(false);
      await expectFixtureStopped(ws);
    },
    timeout,
  );

  test.each(["run", "validate"])(
    "%s rejects missing and duplicate scope options before starting Codex",
    async (command) => {
      const ws = workspace();
      stage(ws, "stage.md");
      for (const { args, diagnostic } of [
        { args: [command, "stages", "--scope"], diagnostic: /scope.*nonempty single-line/i },
        {
          args: [command, "stages", "--scope", "PR", "--scope", "commit"],
          diagnostic: /--scope.*only once/i,
        },
      ]) {
        const result = await launch(ws, args).result;
        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(diagnostic);
        expect(events(ws)).toEqual([]);
      }
    },
    timeout,
  );

  test.each(["run", "validate"])(
    "%s rejects blank, multiline, control, and format characters in CLI scope before starting Codex",
    async (command) => {
      const ws = workspace();
      stage(ws, "stage.md");
      for (const scope of [
        "",
        "   ",
        "\u00a0\u3000",
        "one\ntwo",
        "one\rtwo",
        "\tPR",
        "PR\t",
        "hello\u001b[31m",
        "hello\u007f",
        "hello\u0085world",
        "hello\u200bworld",
        "\ufeffPR",
        "one\u2028two",
        "one\u2029two",
      ]) {
        const result = await launch(ws, [command, "stages", "--scope", scope]).result;
        expect(result.code).toBe(1);
        expect(result.stderr).toMatch(/scope.*nonempty single-line/i);
        expect(events(ws)).toEqual([]);
      }
    },
    timeout,
  );

  test(
    "invalid frontmatter is rejected before even model discovery starts",
    async () => {
      const ws = workspace();
      stage(ws, "valid.md");
      writeFileSync(join(ws.stages, "invalid.md"), "---\nname: Broken\nstep: [\n---\nPrompt\n");
      const result = await launch(ws).result;
      expect(result.code).toBe(1);
      expect(result.output).toContain("invalid.md");
      expect(events(ws)).toEqual([]);
    },
    timeout,
  );

  test(
    "duplicate names across layers are rejected before Codex starts",
    async () => {
      const ws = workspace();
      stage(ws, "one.md", { name: "Repeated", step: 0 });
      stage(ws, "two.md", { name: " Repeated ", step: 9 });
      const result = await launch(ws).result;
      expect(result.code).toBe(1);
      expect(result.output).toMatch(/duplicate/i);
      expect(events(ws)).toEqual([]);
    },
    timeout,
  );

  test.each(["outside", "bare", "metadata"])(
    "run refuses a directory without a Git worktree before Codex or logging starts: %s",
    async (kind) => {
      const ws = workspace({ git: kind === "metadata" });
      if (kind === "bare") {
        const init = Bun.spawnSync(["git", "init", "--bare", "--quiet", ws.repo], {
          env: ws.env,
        });
        expect(init.exitCode).toBe(0);
      } else if (kind === "metadata") {
        ws.cwd = join(ws.repo, ".git");
        ws.stages = join(ws.cwd, "stages");
      }
      stage(ws, "stage.md");
      const result = await launch(ws).result;
      expect(result.code).toBe(1);
      expect(result.output).toMatch(/git|repository/i);
      expect(events(ws)).toEqual([]);
      expect(existsSync(join(ws.root, "home", ".local", "state", "passes", "runs"))).toBe(false);
    },
    timeout,
  );

  test.each(["root", "nested"])(
    "runs every layer in the %s invocation directory and preserves accumulated edits",
    async (location) => {
      const ws = workspace({ nested: location === "nested" });
      writeFileSync(join(ws.cwd, "dirty.txt"), "user changes\n");
      stage(ws, "first.md", {
        prompt: directive("first", {
          appendFile: { path: "dirty.txt", content: "first layer edit\n" },
        }),
      });
      stage(ws, "second.md", {
        step: 1,
        prompt: directive("second", {
          appendFile: { path: "dirty.txt", content: "second layer edit\n" },
        }),
      });
      const result = await launch(ws).result;
      expect(result.code).toBe(0);
      expect(readFileSync(join(ws.cwd, "dirty.txt"), "utf8")).toBe(
        "user changes\nfirst layer edit\nsecond layer edit\n",
      );
      if (location === "nested") expect(existsSync(join(ws.repo, "dirty.txt"))).toBe(false);
      await expectFixtureStopped(ws);
    },
    timeout,
  );

  test.each([
    { model: "not-in-catalog", effort: "medium", message: /not-in-catalog.*not in.*catalog/i },
    { model: "mock-model", effort: "ultra", message: /ultra.*unsupported/i },
  ])(
    "unsupported model/effort fails before any exec: %j",
    async ({ model, effort, message }) => {
      const ws = workspace();
      stage(ws, "supported-first.md", { step: 0 });
      stage(ws, "unsupported.md", { model, effort, step: 5 });
      const result = await launch(ws).result;
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("unsupported.md");
      expect(result.stderr).toMatch(message);
      expect(events(ws).filter((event) => event.kind === "start")).toEqual([]);
      await expectFixtureStopped(ws);
    },
    timeout,
  );

  test(
    "rejects an older Codex version before querying models or executing stages",
    async () => {
      const ws = workspace();
      ws.env.PASSES_TEST_CODEX_VERSION = "0.159.1";
      stage(ws, "stage.md");
      const result = await launch(ws).result;
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/0\.159\.1.*too old/i);
      expect(result.stderr).toContain("0.159.2 or newer");
      expect(events(ws).some((event) => event.kind === "app-server")).toBe(false);
      expect(events(ws).some((event) => event.kind === "start")).toBe(false);
      await expectFixtureStopped(ws);
    },
    timeout,
  );

  test(
    "malformed model catalog fails closed and stops the app-server",
    async () => {
      const ws = workspace();
      ws.env.PASSES_TEST_CATALOG_MODE = "invalid";
      stage(ws, "stage.md");
      const result = await launch(ws).result;
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/catalog.*JSON/i);
      expect(events(ws).some((event) => event.kind === "start")).toBe(false);
      await expectFixtureStopped(ws);
    },
    timeout,
  );

  test(
    "interrupt during catalog discovery stops the app-server without starting stages",
    async () => {
      const ws = workspace();
      ws.env.PASSES_TEST_CATALOG_MODE = "hold";
      stage(ws, "stage.md");
      const { child, result } = launch(ws);
      await waitFor(
        () => events(ws).some((event) => event.kind === "rpc" && event.method === "model/list"),
        "catalog request",
      );
      child.kill("SIGINT");
      expect((await result).code).toBe(130);
      expect(events(ws).some((event) => event.kind === "start")).toBe(false);
      await expectFixtureStopped(ws);
    },
    timeout,
  );

  test(
    "queries subsequent catalog pages before executing a model found on a later page",
    async () => {
      const ws = workspace();
      ws.env.PASSES_TEST_CATALOG_MODE = "paginated";
      stage(ws, "stage.md", {
        prompt: directive("later-page", {
          appendFile: { path: "edit.txt", content: "later page model ran\n" },
        }),
      });
      const result = await launch(ws).result;
      expect(result.code).toBe(0);
      expect(readFileSync(join(ws.cwd, "edit.txt"), "utf8")).toBe("later page model ran\n");
      const log = events(ws);
      const requests = log.filter((event) => event.kind === "rpc" && event.method === "model/list");
      expect(requests.some((event) => event.cursor === "page-2")).toBe(true);
      const startIndex = log.findIndex((event) => event.kind === "start");
      expect(log.filter((event) => event.kind === "start")).toHaveLength(1);
      const lastRequest = log.findLastIndex(
        (event) => event.kind === "rpc" && event.method === "model/list",
      );
      expect(startIndex).toBeGreaterThan(lastRequest);
      await expectFixtureStopped(ws);
    },
    timeout,
  );

  test(
    "accepts a complete catalog response with nextCursor omitted",
    async () => {
      const ws = workspace();
      ws.env.PASSES_TEST_CATALOG_MODE = "no-cursor";
      stage(ws, "stage.md", {
        prompt: directive("complete-catalog", {
          appendFile: { path: "edit.txt", content: "complete catalog model ran\n" },
        }),
      });
      const result = await launch(ws).result;
      expect(result.code).toBe(0);
      expect(readFileSync(join(ws.cwd, "edit.txt"), "utf8")).toBe("complete catalog model ran\n");
      const log = events(ws);
      expect(log.filter((event) => event.kind === "start")).toHaveLength(1);
      await expectFixtureStopped(ws);
    },
    timeout,
  );

  test(
    "rejects a repeated catalog cursor without executing any stage",
    async () => {
      const ws = workspace();
      ws.env.PASSES_TEST_CATALOG_MODE = "repeated";
      stage(ws, "stage.md");
      const result = await launch(ws).result;
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(/repeated.*cursor/i);
      expect(events(ws).some((event) => event.kind === "start")).toBe(false);
      await expectFixtureStopped(ws);
    },
    timeout,
  );

  test(
    "bounds same-step stage execution to four concurrent Codex processes",
    async () => {
      const ws = workspace();
      const ids = Array.from({ length: 5 }, (_, index) => `stage-${index}`);
      for (const id of ids) {
        stage(ws, `${id}.md`, {
          name: id,
          prompt: directive(id, {
            minimumStarts: 4,
            releaseFile: join(ws.root, `release-${id}`),
          }),
        });
      }
      const execution = launch(ws);
      await waitFor(
        () => events(ws).filter((event) => event.kind === "ready").length >= 4,
        "four stages waiting for release",
      );
      const started = events(ws)
        .filter((event) => event.kind === "start")
        .map((event) => event.id);
      expect(started).toHaveLength(4);
      const released = started[0]!;
      const queued = ids.find((id) => !started.includes(id))!;
      writeFileSync(join(ws.root, `release-${released}`), "release");
      await waitFor(
        () => events(ws).some((event) => event.kind === "ready" && event.id === queued),
        "queued stage taking the released slot",
      );
      for (const id of ids) writeFileSync(join(ws.root, `release-${id}`), "release");
      const result = await execution.result;
      expect(result.code).toBe(0);
      const log = events(ws);
      expect(
        log
          .filter((event) => event.kind === "start")
          .map((event) => event.id)
          .sort(),
      ).toEqual(ids);
      expect(
        log
          .filter((event) => event.kind === "finish")
          .map((event) => event.id)
          .sort(),
      ).toEqual(ids);
      expect(
        log.findIndex((event) => event.kind === "start" && event.id === queued),
      ).toBeGreaterThan(log.findIndex((event) => event.kind === "finish" && event.id === released));
      const active = new Set<string>();
      let peak = 0;
      for (const event of log) {
        if (!event.id) continue;
        if (event.kind === "start") {
          active.add(event.id);
          peak = Math.max(peak, active.size);
        } else if (event.kind === "finish") {
          active.delete(event.id);
        }
      }
      expect(peak).toBe(4);
      expect(active.size).toBe(0);
      await expectFixtureStopped(ws);
    },
    timeout,
  );

  test(
    "same-step stages overlap and later layers wait for every preceding stage",
    async () => {
      const ws = workspace();
      stage(ws, "alpha.md", {
        name: "Alpha stage",
        prompt: directive("alpha", {
          barrier: ["alpha", "beta"],
          releaseFile: join(ws.root, "release-alpha"),
        }),
      });
      stage(ws, "beta.md", {
        name: "Beta stage",
        prompt: directive("beta", { barrier: ["alpha", "beta"] }),
      });
      stage(ws, "review.md", { name: "Review stage", step: 7, prompt: directive("review") });
      const execution = launch(ws);
      await waitFor(() => execution.stdout.includes("Beta stage: completed"), "beta completion");
      expect(events(ws).some((event) => event.kind === "start" && event.id === "review")).toBe(
        false,
      );
      writeFileSync(join(ws.root, "release-alpha"), "release");
      const result = await execution.result;
      expect(result.code).toBe(0);
      const log = events(ws);
      const position = (kind: string, id: string) =>
        log.findIndex((e) => e.kind === kind && e.id === id);
      for (const id of ["alpha", "beta"]) {
        expect(position("start", id)).toBeGreaterThan(-1);
        expect(position("barrier", id)).toBeGreaterThan(position("start", id));
        expect(position("finish", id)).toBeGreaterThan(position("barrier", id));
        expect(position("start", "review")).toBeGreaterThan(position("finish", id));
      }
      expect(Math.max(position("start", "alpha"), position("start", "beta"))).toBeLessThan(
        Math.min(position("finish", "alpha"), position("finish", "beta")),
      );
      await expectFixtureStopped(ws);
    },
    timeout,
  );

  test(
    "preserves nested invocation cwd, raw Markdown, requested argv, and dirty files",
    async () => {
      const ws = workspace({ nested: true });
      const marker = join(ws.cwd, "injected-marker");
      const model = `mock-model; : > '${marker}'; $(: > '${marker}')`;
      ws.env.PASSES_TEST_MODELS = JSON.stringify([model]);
      const prompt = directive("argv", {
        stdout: "stdout sentinel\npartial stdout",
        stderr: "stderr sentinel\npartial stderr",
        appendFile: { path: "dirty.txt", content: "agent edit\n" },
      });
      stage(ws, "stage.md", { name: "Output stage", model, effort: "high", prompt });
      writeFileSync(join(ws.cwd, "dirty.txt"), "pre-existing work\n");
      const result = await launch(ws, ["run", "stages", "--verbose"]).result;
      expect(result.code).toBe(0);
      const start = events(ws).find((event) => event.kind === "start");
      expect(start?.cwd).toBe(ws.cwd);
      expect(start?.prompt).toBe(`${prompt}\n\n${commitInstructions}\n`);
      expect(start?.args).toContain(model);
      const args = start?.args ?? [];
      const valueAfter = (flag: string) => {
        expect(args).toContain(flag);
        return args[args.indexOf(flag) + 1];
      };
      expect(valueAfter("--model")).toBe(model);
      expect(valueAfter("-c")).toBe('model_reasoning_effort="high"');
      expect(args).toContain("--approve-for-me");
      expect(valueAfter("--cd")).toBe(ws.cwd);
      expect(valueAfter("--color")).toBe("never");
      expect(args).toContain("--ephemeral");
      expect(args.at(-1)).toBe("-");
      expect(existsSync(marker)).toBe(false);
      expect(readFileSync(join(ws.cwd, "dirty.txt"), "utf8")).toBe(
        "pre-existing work\nagent edit\n",
      );
      for (const token of [
        "stdout sentinel",
        "partial stdout",
        "stderr sentinel",
        "partial stderr",
      ]) {
        const line = result.output.split("\n").find((line) => line.includes(token));
        expect(line).toBeDefined();
        expect(line).toContain("Output stage");
      }
      await expectFixtureStopped(ws);
    },
    timeout,
  );

  test(
    "passes quoted reasoning effort as one TOML value without evaluating shell text",
    async () => {
      const ws = workspace({ nested: true });
      const marker = join(ws.cwd, "effort-injected-marker");
      const effort = `high"; x = true # $(: > '${marker}')`;
      ws.env.PASSES_TEST_EFFORTS = JSON.stringify([effort]);
      stage(ws, "quoted.md", { effort });
      const result = await launch(ws).result;
      expect(result.code).toBe(0);
      const starts = events(ws).filter((event) => event.kind === "start");
      expect(starts).toHaveLength(1);
      const args = starts[0]?.args ?? [];
      expect(args).toContain("-c");
      expect(args[args.indexOf("-c") + 1]).toBe(
        `model_reasoning_effort="high\\"; x = true # $(: > '${marker}')"`,
      );
      expect(existsSync(marker)).toBe(false);
      await expectFixtureStopped(ws);
    },
    timeout,
  );

  test(
    "streams Unicode, long lines and partial stdout/stderr without losing content or labels",
    async () => {
      const ws = workspace();
      stage(ws, "unicode.md", {
        name: "Unicode stage",
        prompt: directive("unicode", {
          outputBytewise: true,
          stdout: "héllo 🌍\r\npartial output",
          stderr: "échec 🌍\r\npartial error",
        }),
      });
      const longLine = "x".repeat(20_000);
      stage(ws, "long.md", {
        name: "Long stage",
        prompt: directive("long", { stdout: `${longLine}\n`, hold: true }),
      });
      const stageLines = (text: string, prefix: string) =>
        text
          .split("\n")
          .filter((line) => line.startsWith(prefix))
          .map((line) => line.slice(prefix.length));
      const execution = launch(ws, ["run", "stages", "--verbose"]);
      await waitFor(
        () =>
          stageLines(execution.stdout, "[Long stage] ").join("") === longLine &&
          execution.stdout.includes("Unicode stage: completed"),
        "complete long output and drained Unicode output before cancellation",
      );
      execution.child.kill("SIGINT");
      const result = await execution.result;
      expect(result.code).toBe(130);
      expect(stageLines(result.stdout, "[Unicode stage] ")).toEqual(["héllo 🌍", "partial output"]);
      expect(stageLines(result.stderr, "[Unicode stage stderr] ")).toEqual([
        "échec 🌍",
        "partial error",
      ]);
      expect(stageLines(result.stdout, "[Long stage] ").join("")).toBe(longLine);
      await expectFixtureStopped(ws);
    },
    timeout,
  );

  test(
    "stage failure kills stubborn siblings and descendants, retains edits, and blocks later layers",
    async () => {
      const ws = workspace();
      writeFileSync(join(ws.cwd, "dirty.txt"), "user changes\n");
      stage(ws, "survivor.md", {
        name: "Stubborn sibling",
        prompt: directive("survivor", {
          hold: true,
          ignoreTerm: true,
          spawnDescendant: true,
          appendFile: { path: "dirty.txt", content: "partial stage edit\n" },
        }),
      });
      stage(ws, "fail.md", {
        name: "Failing stage",
        prompt: directive("fail", { waitForDescendantOf: ["survivor"], exitCode: 17 }),
      });
      stage(ws, "later.md", { step: 1, prompt: directive("later") });
      const result = await launch(ws).result;
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Failing stage");
      expect(result.stderr).toContain("exit code 17");
      expect(events(ws).some((event) => event.kind === "start" && event.id === "later")).toBe(
        false,
      );
      expect(events(ws).some((event) => event.kind === "descendant")).toBe(true);
      expect(readFileSync(join(ws.cwd, "dirty.txt"), "utf8")).toBe(
        "user changes\npartial stage edit\n",
      );
      await expectFixtureStopped(ws);
    },
    timeout,
  );

  test.each([0, 17])(
    "a stage exiting with code %s kills its own TERM-ignoring descendants before returning",
    async (exitCode) => {
      const ws = workspace();
      stage(ws, "failure.md", {
        prompt: directive("failure", {
          spawnDescendant: true,
          waitForDescendantOf: ["failure"],
          exitCode,
        }),
      });
      stage(ws, "later.md", {
        step: 1,
        prompt: directive("later", {
          appendFile: { path: "later.txt", content: "later stage ran\n" },
        }),
      });
      const result = await launch(ws).result;
      expect(result.code).toBe(exitCode === 0 ? 0 : 1);
      if (exitCode === 0) {
        expect(readFileSync(join(ws.cwd, "later.txt"), "utf8")).toBe("later stage ran\n");
      } else {
        expect(result.stderr).toContain("exit code 17");
      }
      expect(events(ws).some((event) => event.kind === "descendant")).toBe(true);
      expect(events(ws).some((event) => event.kind === "start" && event.id === "later")).toBe(
        exitCode === 0,
      );
      await expectFixtureStopped(ws);
    },
    timeout,
  );

  test.each(["SIGINT", "SIGTERM"] as const)(
    "%s exits nonzero and cleans subprocess trees",
    async (signal) => {
      const ws = workspace();
      stage(ws, "waiting.md", {
        name: "Waiting stage",
        prompt: directive("waiting", { hold: true, ignoreTerm: true, spawnDescendant: true }),
      });
      stage(ws, "later.md", { step: 2, prompt: directive("later") });
      const { child, result } = launch(ws);
      await waitFor(
        () => events(ws).some((event) => event.kind === "descendant"),
        "descendant readiness",
      );
      child.kill(signal);
      const completed = await result;
      expect(completed.code).toBe(signal === "SIGINT" ? 130 : 143);
      expect(events(ws).some((event) => event.kind === "start" && event.id === "later")).toBe(
        false,
      );
      await expectFixtureStopped(ws);
    },
    timeout,
  );

  test.each(["SIGINT", "SIGTERM"] as const)(
    "%s remains the exit status when another signal arrives during cleanup",
    async (signal) => {
      const ws = workspace();
      stage(ws, "waiting.md", {
        prompt: directive("waiting", { hold: true, ignoreTerm: true, spawnDescendant: true }),
      });
      stage(ws, "later.md", { step: 1, prompt: directive("later") });
      const execution = launch(ws);
      await waitFor(
        () => events(ws).some((event) => event.kind === "descendant"),
        "descendant readiness",
      );
      execution.child.kill(signal);
      await waitFor(() => execution.stderr.includes("cancelling active stages"), "cancellation");
      execution.child.kill(signal === "SIGINT" ? "SIGTERM" : "SIGINT");
      const result = await execution.result;
      expect(result.code).toBe(signal === "SIGINT" ? 130 : 143);
      expect(result.stderr.match(/cancelling active stages/g)).toHaveLength(1);
      expect(events(ws).some((event) => event.kind === "start" && event.id === "later")).toBe(
        false,
      );
      await expectFixtureStopped(ws);
    },
    timeout,
  );

  test(
    "a closed stdout pipe cancels stubborn stages and descendants",
    async () => {
      const ws = workspace();
      const releaseFile = join(ws.root, "release");
      stage(ws, "waiting.md", {
        prompt: directive("waiting", { hold: true, ignoreTerm: true, spawnDescendant: true }),
      });
      stage(ws, "writer.md", { prompt: directive("writer", { releaseFile }) });
      stage(ws, "later.md", { step: 1, prompt: directive("later") });
      const child = spawn(
        process.execPath,
        [join(import.meta.dir, "../src/cli.ts"), "run", "stages"],
        {
          cwd: ws.cwd,
          env: ws.env,
          stdio: ["ignore", "pipe", "pipe"],
        },
      );
      let stderr = "";
      child.stderr.on("data", (chunk: Buffer) => {
        stderr += chunk.toString();
      });
      child.stdout.resume();
      const exited = new Promise<number | null>((resolve, reject) => {
        child.once("error", reject);
        child.once("close", resolve);
      });
      try {
        await waitFor(
          () =>
            events(ws).some((event) => event.kind === "descendant") &&
            events(ws).some((event) => event.kind === "ready" && event.id === "writer"),
          "both stages ready",
        );
        child.stdout.destroy();
        writeFileSync(releaseFile, "release\n");
        expect(await exited).toBe(143);
        expect(stderr).toContain("SIGTERM: cancelling active stages");
        expect(events(ws).some((event) => event.kind === "start" && event.id === "later")).toBe(
          false,
        );
        await expectFixtureStopped(ws);
      } finally {
        child.kill("SIGKILL");
        await exited;
      }
    },
    timeout,
  );

  test.each([
    { args: ["run", "stages", "--unexpected"], message: /Expected passes/ },
    { args: ["run", "stages", "extra"], message: /Expected passes/ },
    { args: ["validate"], message: /Expected passes/ },
    { args: ["validate", "stages", "--verbose"], message: /--verbose.*only supported by run/ },
    { args: ["run", "stages", "--verbose", "--verbose"], message: /--verbose.*only once/ },
  ])(
    "rejects unsupported CLI arguments: %j",
    async ({ args, message }) => {
      const ws = workspace();
      stage(ws, "stage.md");
      const result = await launch(ws, args).result;
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(message);
      expect(events(ws)).toEqual([]);
    },
    timeout,
  );

  test.each(["--help", "--version"])(
    "%s works without a repository or Codex",
    async (flag) => {
      const ws = workspace({ git: false, codex: false });
      const result = await launch(ws, [flag]).result;
      expect(result.code).toBe(0);
      if (flag === "--help") {
        expect(result.stdout).toContain("passes run <stages-directory>");
        expect(result.stdout).toContain("--scope <text>");
      } else {
        expect(result.stdout.trim()).toMatch(/^passes \d+\.\d+\.\d+$/);
      }
      expect(events(ws)).toEqual([]);
    },
    timeout,
  );
});
