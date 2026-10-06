import { expect } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

const project = resolve(import.meta.dir, "..");
const cli = join(project, "src/cli.ts");
const fixture = join(import.meta.dir, "fixtures/codex.ts");
const temporary: Workspace[] = [];
const runners: ReturnType<typeof Bun.spawn>[] = [];
export const timeout = 20_000;
export const commitInstructions =
  "After completing the stage, inspect your changes and commit them. Use a short subject describing the outcome. In the body, explain why and show a compact Before → After sketch when useful. Record only checks actually run. Skip empty commits.";

export interface Event {
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

export interface Workspace {
  root: string;
  repo: string;
  cwd: string;
  stages: string;
  eventPath: string;
  env: Record<string, string | undefined>;
}

export interface Stage {
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

export function workspace({ git = true, codex = true, nested = false } = {}): Workspace {
  // macOS exposes /var through /private/var in subprocess cwd values.
  const root = realpathSync(mkdtempSync(join(tmpdir(), "passes-cli-test-")));
  const repo = join(root, "repo");
  const cwd = nested ? join(repo, "packages", "nested app") : repo;
  const stages = join(cwd, "stages");
  const bin = join(root, "bin");
  mkdirSync(stages, { recursive: true });
  mkdirSync(bin);
  const home = join(root, "home");
  mkdirSync(home);
  const eventPath = join(root, "events.jsonl");
  // Only expose the chosen external tools. Ambient Codex fixtures and Git
  // configuration must not change the catalog, repository, or test outcome.
  const env = {
    PATH: bin,
    HOME: home,
    TMPDIR: root,
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CEILING_DIRECTORIES: root,
    PASSES_TEST_EVENTS: eventPath,
    NO_COLOR: "1",
  };
  const ws: Workspace = { root, repo, cwd, stages, eventPath, env };
  temporary.push(ws);
  if (git || codex) {
    const gitExecutable = Bun.which("git");
    if (!gitExecutable) throw new Error("Git is required for CLI acceptance tests");
    symlinkSync(gitExecutable, join(bin, "git"));
  }
  if (git) {
    const result = Bun.spawnSync(
      [join(bin, "git"), "init", "--quiet", "--initial-branch=main", repo],
      {
        env,
      },
    );
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  }
  if (codex) {
    const executable = join(bin, "codex");
    writeFileSync(
      executable,
      `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(fixture)} "$@"\n`,
    );
    chmodSync(executable, 0o755);
  }
  return ws;
}

export function stage(ws: Workspace, filename: string, options: Stage = {}): string {
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

export function directive(id: string, extra: Record<string, unknown> = {}): string {
  return `fixture:${JSON.stringify({ id, ...extra })}\n\n# Instructions\nKeep literal \${values}.\n`;
}

export function events(ws: Workspace): Event[] {
  if (!existsSync(ws.eventPath)) return [];
  return readFileSync(ws.eventPath, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Event);
}

export function launch(ws: Workspace, args: readonly string[] = ["run", "stages"]) {
  const child = Bun.spawn([process.execPath, cli, ...args], {
    cwd: ws.cwd,
    env: ws.env,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  runners.push(child);
  const captured = { stdout: "", stderr: "" };
  async function collect(stream: ReadableStream<Uint8Array>, channel: "stdout" | "stderr") {
    const decoder = new TextDecoder();
    for await (const chunk of stream) captured[channel] += decoder.decode(chunk, { stream: true });
    captured[channel] += decoder.decode();
    return captured[channel];
  }
  const stdout = collect(child.stdout, "stdout");
  const stderr = collect(child.stderr, "stderr");
  const result = Promise.all([child.exited, stdout, stderr]).then(([code, out, err]) => ({
    code,
    stdout: out,
    stderr: err,
    output: out + err,
  }));
  return {
    child,
    result,
    get stdout() {
      return captured.stdout;
    },
  };
}

export async function waitFor(
  predicate: () => boolean,
  description: string,
  ms = 8_000,
): Promise<void> {
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

export async function expectFixtureStopped(ws: Workspace): Promise<void> {
  const pids = [...new Set(events(ws).flatMap((event) => (event.pid ? [event.pid] : [])))];
  expect(pids.length).toBeGreaterThan(0);
  await waitFor(() => pids.every((pid) => !processAlive(pid)), "all Codex processes to stop");
}

export async function cleanup(): Promise<void> {
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
}
