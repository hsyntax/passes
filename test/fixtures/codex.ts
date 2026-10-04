import { appendFileSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { createInterface } from "node:readline";

const eventPath = process.env.PASSES_TEST_EVENTS;
if (!eventPath) throw new Error("PASSES_TEST_EVENTS is required by the test fixture");

interface Directive {
  id: string;
  barrier?: string[];
  waitForDescendantOf?: string[];
  waitForFile?: string;
  exitCode?: number;
  exitSignal?: NodeJS.Signals;
  descendantOutput?: boolean;
  hold?: boolean;
  tickOutput?: boolean;
  termOutput?: string;
  ignoreTerm?: boolean;
  spawnDescendant?: boolean;
  stdout?: string;
  stderr?: string;
  appendFile?: { path: string; content: string };
}

interface Event {
  kind: string;
  id?: string;
  pid?: number;
  [key: string]: unknown;
}

function log(event: Event): void {
  appendFileSync(eventPath as string, `${JSON.stringify(event)}\n`);
}

function events(): Event[] {
  if (!existsSync(eventPath as string)) return [];
  return readFileSync(eventPath as string, "utf8")
    .trim()
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as Event);
}

async function waitFor(predicate: () => boolean): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate()) {
    if (Date.now() >= deadline) {
      log({ kind: "fixture-timeout", pid: process.pid });
      process.exit(93);
    }
    await Bun.sleep(10);
  }
}

const args = process.argv.slice(2);
if (args[0] === "--version") {
  log({ kind: "version", pid: process.pid, args });
  process.stdout.write(`codex-cli ${process.env.PASSES_TEST_CODEX_VERSION ?? "0.159.2"}\n`);
} else if (args[0] === "__descendant") {
  const id = args[1] ?? "unknown";
  process.on("SIGTERM", () => log({ kind: "descendant-term", id, pid: process.pid }));
  log({ kind: "descendant", id, pid: process.pid, ppid: process.ppid });
  setInterval(() => {}, 1_000);
} else if (args.includes("app-server")) {
  log({ kind: "app-server", pid: process.pid, args, cwd: process.cwd() });
  if (process.env.PASSES_TEST_CATALOG_MODE === "hold") {
    process.on("SIGTERM", () => log({ kind: "app-server-term", pid: process.pid }));
  }
  const lines = createInterface({ input: process.stdin });
  for await (const line of lines) {
    if (!line.trim()) continue;
    const request = JSON.parse(line) as {
      id?: number;
      method: string;
      params?: { cursor?: string };
    };
    log({
      kind: "rpc",
      method: request.method,
      requestId: request.id,
      cursor: request.params?.cursor,
      pid: process.pid,
    });
    if (request.id === undefined) continue;
    let result: unknown = {};
    if (request.method === "initialize") {
      result = { userAgent: "passes-test-fixture/1.0" };
    } else if (request.method === "model/list") {
      if (process.env.PASSES_TEST_CATALOG_MODE === "hold") continue;
      if (process.env.PASSES_TEST_CATALOG_MODE === "oversized") {
        process.stdout.write("x".repeat(1_048_577));
        continue;
      }
      if (process.env.PASSES_TEST_CATALOG_MODE === "invalid") {
        process.stdout.write("not JSON\n");
        continue;
      }
      const catalogMode = process.env.PASSES_TEST_CATALOG_MODE;
      const models =
        catalogMode === "paginated" && !request.params?.cursor
          ? ["unrelated-first-page-model"]
          : (JSON.parse(process.env.PASSES_TEST_MODELS ?? '["mock-model"]') as string[]);
      result = {
        data: models.map((model, index) => ({
          id: `fixture-${index}`,
          model,
          displayName: model,
          description: "Acceptance-test model; no network calls",
          hidden: false,
          isDefault: index === 0,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: (
            JSON.parse(process.env.PASSES_TEST_EFFORTS ?? '["medium", "high"]') as string[]
          ).map((reasoningEffort) => ({ reasoningEffort, description: "" })),
          inputModalities: ["text"],
          supportsPersonality: false,
        })),
        nextCursor:
          catalogMode === "no-cursor"
            ? undefined
            : catalogMode === "repeated"
              ? "repeated-cursor"
              : catalogMode === "paginated" && !request.params?.cursor
                ? "page-2"
                : null,
      };
    } else {
      process.stdout.write(
        `${JSON.stringify({ id: request.id, error: { code: -32601, message: "Unknown method" } })}\n`,
      );
      continue;
    }
    process.stdout.write(`${JSON.stringify({ id: request.id, result })}\n`);
  }
} else if (args.includes("exec")) {
  const prompt = await Bun.stdin.text();
  const firstLine = prompt.split("\n")[0] ?? "";
  const directive: Directive = firstLine.startsWith("fixture:")
    ? (JSON.parse(firstLine.slice("fixture:".length)) as Directive)
    : { id: "plain" };
  log({ kind: "start", id: directive.id, pid: process.pid, args, cwd: process.cwd(), prompt });
  process.on("SIGTERM", () => {
    log({ kind: "term", id: directive.id, pid: process.pid });
    if (directive.termOutput) process.stdout.write(directive.termOutput);
    if (!directive.ignoreTerm) process.exit(143);
  });
  if (directive.appendFile) {
    const path = resolve(process.cwd(), directive.appendFile.path);
    const before = existsSync(path) ? readFileSync(path, "utf8") : "";
    writeFileSync(path, before + directive.appendFile.content);
  }
  if (directive.spawnDescendant) {
    Bun.spawn([process.execPath, import.meta.path, "__descendant", directive.id], {
      stdin: "ignore",
      stdout: directive.descendantOutput ? "inherit" : "ignore",
      stderr: directive.descendantOutput ? "inherit" : "ignore",
      env: process.env,
    });
  }
  if (directive.spawnDescendant) {
    await waitFor(() =>
      events().some((event) => event.kind === "descendant" && event.id === directive.id),
    );
  }
  if (directive.barrier) {
    await waitFor(
      () =>
        directive.barrier?.every((id) => events().some((e) => e.kind === "start" && e.id === id)) ??
        false,
    );
    log({ kind: "barrier", id: directive.id, pid: process.pid });
  }
  if (directive.waitForDescendantOf) {
    await waitFor(
      () =>
        directive.waitForDescendantOf?.every((id) =>
          events().some((e) => e.kind === "descendant" && e.id === id),
        ) ?? false,
    );
  }
  if (directive.stdout) process.stdout.write(directive.stdout);
  if (directive.stderr) process.stderr.write(directive.stderr);
  log({ kind: "output-written", id: directive.id, pid: process.pid });
  if (directive.waitForFile) {
    await waitFor(() => existsSync(resolve(process.cwd(), directive.waitForFile as string)));
  }
  if (directive.hold) {
    setInterval(() => {
      if (directive.tickOutput) process.stdout.write("still running\n");
    }, 25);
  } else {
    log({ kind: "finish", id: directive.id, pid: process.pid, exitCode: directive.exitCode ?? 0 });
    if (directive.exitSignal) process.kill(process.pid, directive.exitSignal);
    else process.exit(directive.exitCode ?? 0);
  }
} else {
  log({ kind: "unexpected", args, pid: process.pid });
  process.stderr.write("Unsupported fake Codex invocation\n");
  process.exit(94);
}
