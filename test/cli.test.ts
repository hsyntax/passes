import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const project = resolve(import.meta.dir, "..");
const cli = join(project, "src/cli.ts");
const fixture = join(import.meta.dir, "fixtures/codex.ts");
const temporary: Workspace[] = [];
const runners: ReturnType<typeof Bun.spawn>[] = [];
const timeout = 20_000;
const commitInstructions =
  "After completing the stage, inspect your changes and commit them. Use a short subject describing the outcome. In the body, explain why and show a compact Before → After sketch when useful. Record only checks actually run. Skip empty commits.";

interface Event {
  kind: string;
  id?: string;
  pid?: number;
  args?: string[];
  cwd?: string;
  prompt?: string;
  method?: string;
  cursor?: string;
  time: number;
}

interface Workspace {
  root: string;
  repo: string;
  cwd: string;
  stages: string;
  eventPath: string;
  env: Record<string, string | undefined>;
}

interface Stage {
  name?: string;
  step?: number;
  model?: string;
  effort?: string;
  scope?: string;
  prompt?: string;
}

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function workspace({ git = true, nested = false } = {}): Workspace {
  // macOS exposes /var through /private/var in subprocess cwd values.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "passes-cli-test-")));
  const repo = join(root, "repo");
  const cwd = nested ? join(repo, "packages", "nested app") : repo;
  const stages = join(cwd, "stages");
  const bin = join(root, "bin");
  mkdirSync(stages, { recursive: true });
  mkdirSync(bin);
  if (git) {
    const result = Bun.spawnSync(["git", "init", "--quiet", repo]);
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  }
  const executable = join(bin, "codex");
  writeFileSync(
    executable,
    `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fixture)} "$@"\n`,
  );
  chmodSync(executable, 0o755);
  const eventPath = join(root, "events.jsonl");
  const ws = {
    root,
    repo,
    cwd,
    stages,
    eventPath,
    env: {
      ...process.env,
      PATH: `${bin}:${process.env.PATH ?? ""}`,
      PASSES_TEST_EVENTS: eventPath,
      NO_COLOR: "1",
    },
  };
  temporary.push(ws);
  return ws;
}

function stage(ws: Workspace, filename: string, options: Stage = {}): string {
  const prompt = options.prompt ?? 'fixture:{"id":"plain"}\nRun this Markdown stage.\n';
  const text = [
    "---",
    `name: ${JSON.stringify(options.name ?? filename)}`,
    `step: ${options.step ?? 0}`,
    `model: ${JSON.stringify(options.model ?? "mock-model")}`,
    `reasoning_effort: ${JSON.stringify(options.effort ?? "medium")}`,
    ...(options.scope === undefined ? [] : [`scope: ${JSON.stringify(options.scope)}`]),
    "---",
    prompt,
  ].join("\n");
  const path = join(ws.stages, filename);
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
  return prompt;
}

function directive(id: string, extra: Record<string, unknown> = {}): string {
  return `fixture:${JSON.stringify({ id, ...extra })}\n\n# Instructions\nKeep literal \${values}.\n`;
}

function events(ws: Workspace): Event[] {
  if (!existsSync(ws.eventPath)) return [];
  return readFileSync(ws.eventPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Event);
}

function launch(ws: Workspace, args: readonly string[] = ["run", "stages"]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd: ws.cwd,
    env: ws.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  runners.push(child);
  const stdout = new Response(child.stdout).text();
  const stderr = new Response(child.stderr).text();
  const result = Promise.all([child.exited, stdout, stderr]).then(([code, out, err]) => ({
    code,
    stdout: out,
    stderr: err,
    output: out + err,
  }));
  return { child, result };
}

async function waitFor(predicate: () => boolean, description: string, ms = 8_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error(`Timed out waiting for ${description}`);
    await Bun.sleep(15);
  }
}

function processAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    // A killed orphan can remain a zombie until the container's init reaps it.
    const status = `/proc/${pid}/status`;
    return !existsSync(status) || !/^State:\s+Z/m.test(readFileSync(status, "utf8"));
  } catch {
    return false;
  }
}

async function expectFixtureStopped(ws: Workspace): Promise<void> {
  const pids = [...new Set(events(ws).flatMap((event) => (event.pid ? [event.pid] : [])))];
  expect(pids.length).toBeGreaterThan(0);
  await waitFor(() => pids.every((pid) => !processAlive(pid)), "all Codex processes to stop");
}

afterEach(async () => {
  for (const child of runners.splice(0)) {
    if (child.exitCode === null) child.kill("SIGKILL");
    await child.exited;
  }
  for (const ws of temporary.splice(0)) {
    for (const event of events(ws)) {
      if (event.pid && processAlive(event.pid)) {
        try {
          process.kill(event.pid, "SIGKILL");
        } catch {
          // Already exited between the probe and kill.
        }
      }
    }
    rmSync(ws.root, { recursive: true, force: true });
  }
});

describe("passes CLI acceptance", () => {
  test(
    "validate prints ordered layers without spawning Codex or requiring a repository",
    async () => {
      const ws = workspace({ git: false });
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
      expect(result.output.search(/step\s+0/i)).toBeLessThan(result.output.search(/step\s+8/i));
      expect(result.output).toMatch(/concurrent|parallel/i);
      expect(result.output).toMatch(/shared|isolat/i);
      expect(events(ws)).toEqual([]);
      expect(readFileSync(join(ws.cwd, "untouched.txt"), "utf8")).toBe("original contents\n");
    },
    timeout,
  );

  test(
    "validate accepts a scope override without resolving it or requiring Git or Codex",
    async () => {
      const ws = workspace({ git: false });
      stage(ws, "stage.md", { scope: "frontmatter default" });
      const marker = join(ws.cwd, "scope-injected-marker");
      const scope = `  PR nonexistent; $(touch ${marker}); \`touch ${marker}\`  `;
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
      const scope = `  commit does-not-exist; $(touch ${marker}); \`touch ${marker}\`; \${literal}  `;
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
      for (const start of starts) {
        expect(start.prompt?.split("\n")[0]).toBe(`Scope: ${scope}`);
        expect(start.args).not.toContain(scope);
        expect(start.args).not.toContain("--scope");
      }
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
      for (const args of [
        [command, "stages", "--scope"],
        [command, "stages", "--scope", "PR", "--scope", "commit"],
      ]) {
        const result = await launch(ws, args).result;
        expect(result.code).not.toBe(0);
        expect(result.output).toContain("scope");
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
        expect(result.code).not.toBe(0);
        expect(result.output).toContain("scope");
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
      expect(result.code).not.toBe(0);
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
      expect(result.code).not.toBe(0);
      expect(result.output).toMatch(/duplicate/i);
      expect(events(ws)).toEqual([]);
    },
    timeout,
  );

  test(
    "run refuses a directory outside a git repository",
    async () => {
      const ws = workspace({ git: false });
      stage(ws, "stage.md");
      const result = await launch(ws).result;
      expect(result.code).not.toBe(0);
      expect(result.output).toMatch(/git|repository/i);
      expect(events(ws)).toEqual([]);
    },
    timeout,
  );

  test.each([
    { model: "not-in-catalog", effort: "medium", message: /model|not-in-catalog/i },
    { model: "mock-model", effort: "ultra", message: /effort|ultra/i },
  ])(
    "unsupported model/effort fails before any exec: %j",
    async ({ model, effort, message }) => {
      const ws = workspace();
      stage(ws, "supported-first.md", { step: 0 });
      stage(ws, "unsupported.md", { model, effort, step: 5 });
      const result = await launch(ws).result;
      expect(result.code).not.toBe(0);
      expect(result.output).toMatch(message);
      expect(events(ws).some((event) => event.kind === "app-server")).toBe(true);
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
      expect(result.code).not.toBe(0);
      expect(result.output).toMatch(/old|version|0\.159\.2/i);
      expect(events(ws).map((event) => event.kind)).toEqual(["version"]);
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
      expect(result.code).not.toBe(0);
      expect(result.output).toMatch(/catalog|compatibility|JSON/i);
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
      stage(ws, "stage.md");
      const result = await launch(ws).result;
      expect(result.code).toBe(0);
      const log = events(ws);
      const requests = log.filter((event) => event.kind === "rpc" && event.method === "model/list");
      expect(requests.map((event) => event.cursor)).toEqual([undefined, "page-2"]);
      const startIndex = log.findIndex((event) => event.kind === "start");
      expect(startIndex).toBeGreaterThan(log.lastIndexOf(requests.at(-1) as Event));
      await expectFixtureStopped(ws);
    },
    timeout,
  );

  test(
    "accepts a complete catalog response with nextCursor omitted",
    async () => {
      const ws = workspace();
      ws.env.PASSES_TEST_CATALOG_MODE = "no-cursor";
      stage(ws, "stage.md");
      const result = await launch(ws).result;
      expect(result.code).toBe(0);
      const log = events(ws);
      expect(
        log.filter((event) => event.kind === "rpc" && event.method === "model/list"),
      ).toHaveLength(1);
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
      expect(result.code).not.toBe(0);
      expect(result.output).toMatch(/cursor|pagination/i);
      expect(
        events(ws).filter((event) => event.kind === "rpc" && event.method === "model/list"),
      ).toHaveLength(2);
      expect(events(ws).some((event) => event.kind === "start")).toBe(false);
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
        prompt: directive("alpha", { barrier: ["alpha", "beta"], delayMs: 150 }),
      });
      stage(ws, "beta.md", {
        name: "Beta stage",
        prompt: directive("beta", { barrier: ["alpha", "beta"], delayMs: 25 }),
      });
      stage(ws, "review.md", { name: "Review stage", step: 7, prompt: directive("review") });
      const result = await launch(ws).result;
      expect(result.code).toBe(0);
      const log = events(ws);
      const position = (kind: string, id: string) =>
        log.findIndex((e) => e.kind === kind && e.id === id);
      for (const id of ["alpha", "beta"]) {
        expect(position("start", id)).toBeGreaterThan(-1);
        expect(position("barrier", id)).toBeGreaterThan(position("start", id));
        expect(position("start", "review")).toBeGreaterThan(position("finish", id));
      }
      expect(Math.max(position("start", "alpha"), position("start", "beta"))).toBeLessThan(
        Math.min(position("finish", "alpha"), position("finish", "beta")),
      );
      expect(log.filter((event) => event.kind === "rpc").map((event) => event.method)).toEqual([
        "initialize",
        "initialized",
        "model/list",
      ]);
      const starts = log.filter((event) => event.kind === "start");
      expect(starts).toHaveLength(3);
      for (const start of starts) {
        expect(start.prompt?.endsWith(`\n\n${commitInstructions}\n`)).toBe(true);
        expect(start.prompt?.split(commitInstructions)).toHaveLength(2);
      }
      await expectFixtureStopped(ws);
    },
    timeout,
  );

  test(
    "preserves nested invocation cwd, raw Markdown, requested argv, and dirty files",
    async () => {
      const ws = workspace({ nested: true });
      const marker = join(ws.cwd, "injected-marker");
      const model = `mock-model; touch ${marker}; $(touch ${marker})`;
      ws.env.PASSES_TEST_MODELS = JSON.stringify([model]);
      const prompt = directive("argv", {
        stdout: "stdout sentinel\npartial stdout",
        stderr: "stderr sentinel\npartial stderr",
        appendFile: { path: "dirty.txt", content: "agent edit\n" },
      });
      stage(ws, "stage.md", { name: "Output stage", model, effort: "high", prompt });
      writeFileSync(join(ws.cwd, "dirty.txt"), "pre-existing work\n");
      const result = await launch(ws).result;
      expect(result.code).toBe(0);
      const start = events(ws).find((event) => event.kind === "start");
      expect(start?.cwd).toBe(ws.cwd);
      expect(start?.prompt).toBe(`${prompt}\n\n${commitInstructions}\n`);
      expect(start?.args).toContain(model);
      const args = start?.args ?? [];
      const valueAfter = (flag: string) => args[args.indexOf(flag) + 1];
      expect(valueAfter("--model")).toBe(model);
      expect(valueAfter("-c")).toBe('model_reasoning_effort="high"');
      expect(valueAfter("--sandbox")).toBe("workspace-write");
      expect(valueAfter("--ask-for-approval")).toBe("never");
      expect(valueAfter("--cd")).toBe(ws.cwd);
      expect(valueAfter("--color")).toBe("never");
      expect(args).toContain("--ephemeral");
      expect(args.at(-1)).toBe("-");
      expect(existsSync(marker)).toBe(false);
      expect(readFileSync(join(ws.cwd, "dirty.txt"), "utf8")).toBe(
        "pre-existing work\nagent edit\n",
      );
      expect(existsSync(join(ws.repo, ".git", "worktrees"))).toBe(false);
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
      expect(result.code).not.toBe(0);
      expect(result.output).toContain("Failing stage");
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

  test.each([
    { args: ["run", "--repo", "other"] },
    { args: ["run", "stages", "extra"] },
    { args: ["validate"] },
  ])(
    "rejects unsupported CLI arguments: %j",
    async ({ args }) => {
      const ws = workspace();
      stage(ws, "stage.md");
      const result = await launch(ws, args).result;
      expect(result.code).not.toBe(0);
      expect(events(ws)).toEqual([]);
    },
    timeout,
  );

  test.each(["--help", "--version"])(
    "%s works without a repository or Codex",
    async (flag) => {
      const ws = workspace({ git: false });
      const result = await launch(ws, [flag]).result;
      expect(result.code).toBe(0);
      expect(result.output.trim().length).toBeGreaterThan(0);
      expect(events(ws)).toEqual([]);
    },
    timeout,
  );
});
