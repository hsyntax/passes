import { Effect, Queue, Schema, Stream } from "effect";
import { message, PassesError } from "./errors.ts";
import { captureTextTail, collectProcess, startProcess } from "./process.ts";
import type { Plan, Stage } from "./stages.ts";

const CatalogEntry = Schema.Struct({
  model: Schema.NonEmptyString,
  supportedReasoningEfforts: Schema.Array(
    Schema.Struct({ reasoningEffort: Schema.NonEmptyString }),
  ),
});
const CatalogPage = Schema.Struct({
  data: Schema.Array(CatalogEntry),
  nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type Model = typeof CatalogEntry.Type;

export function execArgs(stage: Stage, cwd: string): string[] {
  return [
    "--ask-for-approval",
    "never",
    "exec",
    "--model",
    stage.model,
    "-c",
    `model_reasoning_effort=${JSON.stringify(stage.reasoning_effort)}`,
    "--sandbox",
    "workspace-write",
    "--cd",
    cwd,
    "--color",
    "never",
    "--ephemeral",
    "-",
  ];
}

export const readCatalog = Effect.fnUntraced(function* (cwd: string) {
  const proc = yield* startProcess("codex", ["app-server", "--listen", "stdio://"], cwd);
  const requests = yield* Queue.make<string>();
  const send = (request: object) => Queue.offer(requests, `${JSON.stringify(request)}\n`);
  let pending = "";
  let stderr = "";
  let requestId = 1;
  let initialized = false;
  let finished = false;
  const models: Model[] = [];
  const cursors = new Set<string>();
  const list = Effect.fnUntraced(function* (cursor?: string) {
    requestId += 1;
    return yield* send({
      id: requestId,
      method: "model/list",
      params: {
        limit: 100,
        includeHidden: true,
        ...(cursor ? { cursor } : {}),
      },
    });
  });
  const handle = Effect.fnUntraced(function* (line: string) {
    if (!line.trim()) return;
    const rpc = yield* Effect.try({
      try: () => {
        const response: unknown = JSON.parse(line);
        if (!response || typeof response !== "object") throw new Error("invalid JSON-RPC message");
        return response as Record<string, unknown>;
      },
      catch: (error) => new PassesError({ message: message(error), cause: error }),
    });
    if (rpc.id !== requestId) return;
    if (rpc.error)
      return yield* new PassesError({ message: JSON.stringify(rpc.error), cause: rpc.error });
    if (!("result" in rpc)) return yield* new PassesError({ message: "response has no result" });
    if (!initialized) {
      initialized = true;
      yield* send({ method: "initialized", params: {} });
      yield* list();
      return;
    }
    const page = yield* Schema.decodeUnknownEffect(CatalogPage)(rpc.result);
    models.push(...page.data);
    if (page.nextCursor) {
      if (cursors.has(page.nextCursor))
        return yield* new PassesError({ message: "server repeated its pagination cursor" });
      cursors.add(page.nextCursor);
      if (cursors.size > 100)
        return yield* new PassesError({ message: "catalog exceeded 100 pages" });
      yield* list(page.nextCursor);
    } else if (!models.length) {
      return yield* new PassesError({
        message: "server returned no models; check Codex installation/provider configuration",
      });
    } else finished = true;
  });
  const read = proc.stdout.pipe(
    Stream.decodeText(),
    Stream.runForEachWhile(
      Effect.fnUntraced(function* (chunk) {
        pending += chunk;
        let newline = pending.indexOf("\n");
        while (newline >= 0 && !finished) {
          if (newline > 1_048_576)
            return yield* new PassesError({ message: "response exceeded 1 MiB" });
          yield* handle(pending.slice(0, newline));
          pending = pending.slice(newline + 1);
          newline = pending.indexOf("\n");
        }
        if (!finished && pending.length > 1_048_576)
          return yield* new PassesError({ message: "response exceeded 1 MiB without a newline" });
        return !finished;
      }),
    ),
    Effect.flatMap(() =>
      finished
        ? Effect.succeed(models)
        : Effect.fail(
            new PassesError({ message: "app-server closed stdout before returning a catalog" }),
          ),
    ),
  );
  yield* send({
    id: 1,
    method: "initialize",
    params: {
      clientInfo: { name: "passes_runner", title: "Passes Runner", version: "0.1.0" },
      capabilities: { explicitGatewayOauth: true },
    },
  });
  return yield* Effect.raceAllFirst([
    read,
    Stream.fromQueue(requests).pipe(
      Stream.encodeText,
      Stream.run(proc.stdin),
      Effect.andThen(Effect.never),
    ),
    captureTextTail(proc.stderr, 8_000, (text) => (stderr = text)).pipe(
      Effect.andThen(Effect.never),
    ),
    proc.exitCode.pipe(
      Effect.flatMap((code) =>
        Effect.fail(
          new PassesError({ message: `app-server exited before returning a catalog (${code})` }),
        ),
      ),
    ),
  ]).pipe(
    Effect.timeout(15_000),
    Effect.mapError(
      (error) =>
        new PassesError({
          message: `Could not check Codex model compatibility: ${message(error)}${stderr ? `\n${stderr.trim()}` : ""}`,
          cause: error,
        }),
    ),
  );
}, Effect.scoped);

export const preflight = Effect.fnUntraced(function* (plan: Plan) {
  if (process.platform === "win32")
    return yield* new PassesError({
      message:
        "passes currently supports macOS and Linux; safe process-group cancellation requires POSIX.",
    });
  const git = yield* collectProcess("git", ["rev-parse", "--is-inside-work-tree"], plan.cwd);
  if (git.code !== 0 || git.stdout.trim() !== "true")
    return yield* new PassesError({
      message:
        "Run passes from inside the existing Git checkout you want to work on. No repository is created or switched.",
    });
  const version = yield* collectProcess("codex", ["--version"], plan.cwd);
  const match = /codex(?:-cli)?\s+(\d+)\.(\d+)\.(\d+)/.exec(version.stdout);
  if (version.code !== 0 || !match)
    return yield* new PassesError({
      message: `Could not determine Codex CLI version. Install Codex CLI 0.159.2 or newer. ${version.stderr.trim()}`,
    });
  const [major, minor, patch] = match.slice(1).map(Number);
  if (major === 0 && ((minor ?? 0) < 159 || (minor === 159 && (patch ?? 0) < 2)))
    return yield* new PassesError({
      message: `Codex ${match[0]} is too old. Install Codex CLI 0.159.2 or newer for the verified model-catalog protocol and execution flags.`,
    });
  const catalog = yield* readCatalog(plan.cwd);
  const errors: string[] = [];
  for (const stage of plan.stages) {
    const model = catalog.find((item) => item.model === stage.model);
    if (!model)
      errors.push(
        `${stage.file}: model "${stage.model}" is not in the installed Codex catalog. Available models: ${catalog.map((m) => m.model).join(", ")}`,
      );
    else if (
      !model.supportedReasoningEfforts.some(
        (effort) => effort.reasoningEffort === stage.reasoning_effort,
      )
    )
      errors.push(
        `${stage.file}: reasoning_effort "${stage.reasoning_effort}" is unsupported for model "${stage.model}". Supported: ${model.supportedReasoningEfforts.map((e) => e.reasoningEffort).join(", ") || "none"}`,
      );
  }
  if (errors.length)
    return yield* new PassesError({
      message: `Model compatibility check failed:\n${errors.map((error) => `  ${error}`).join("\n")}`,
    });
});
