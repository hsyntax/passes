import { Effect, Fiber, Queue, Schema, Stream } from "effect";
import { message, PassesError } from "./errors.ts";
import { runCommand, startProcess } from "./process.ts";
import type { Plan, Stage } from "./stages.ts";

const ModelCatalogEntry = Schema.Struct({
  model: Schema.NonEmptyString,
  supportedReasoningEfforts: Schema.Array(
    Schema.Struct({ reasoningEffort: Schema.NonEmptyString }),
  ),
  serviceTiers: Schema.optionalKey(Schema.Array(Schema.Struct({ id: Schema.NonEmptyString }))),
  additionalSpeedTiers: Schema.optionalKey(Schema.Array(Schema.NonEmptyString)),
});
const ModelCatalogPage = Schema.Struct({
  data: Schema.Array(ModelCatalogEntry),
  nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
type CatalogModel = typeof ModelCatalogEntry.Type;

export function stagePrompt(stage: Stage, scopeOverride?: string): string {
  const scope = scopeOverride ?? stage.scope;
  const prefix = scope === undefined ? "" : `Scope: ${scope}\n\n`;
  return `${prefix}${stage.prompt}\n\nAfter completing the stage, inspect your changes and commit them. Use a short subject describing the outcome. In the body, explain why and show a compact Before → After sketch when useful. Record only checks actually run. Skip empty commits.\n`;
}

export function buildCodexExecArgs(
  stage: Stage,
  invocationDirectory: string,
  fastModeEnabled = false,
): string[] {
  return [
    "exec",
    "--approve-for-me",
    "--model",
    stage.model,
    "-c",
    `model_reasoning_effort=${JSON.stringify(stage.reasoning_effort)}`,
    ...(fastModeEnabled ? ["--enable", "fast_mode", "-c", 'service_tier="fast"'] : []),
    "--cd",
    invocationDirectory,
    "--color",
    "never",
    "--ephemeral",
    "-",
  ];
}

const loadModelCatalog = Effect.fn("Codex.loadModelCatalog")(
  (invocationDirectory: string, fastModeRequested: boolean) =>
    Effect.scoped(
      Effect.gen(function* () {
        const input = yield* Queue.unbounded<Uint8Array>();
        const proc = yield* startProcess(
          "codex",
          [
            "app-server",
            "--listen",
            "stdio://",
            ...(fastModeRequested ? ["--enable", "fast_mode"] : []),
          ],
          invocationDirectory,
          Stream.fromQueue(input),
        );
        let stderr = "";
        yield* proc.stderr.pipe(
          Stream.decodeText,
          Stream.runForEach((chunk) =>
            Effect.sync(() => {
              stderr = (stderr + chunk).slice(-8_000);
            }),
          ),
          Effect.ignore,
          Effect.forkScoped,
        );
        let requestId = 1;
        let initialized = false;
        let pendingResponseLine = "";
        let completedCatalog: readonly CatalogModel[] | undefined;
        const catalogModels: CatalogModel[] = [];
        const seenCatalogCursors = new Set<string>();
        const sendRpcMessage = Effect.fn((rpcMessage: object) =>
          Queue.offer(input, new TextEncoder().encode(`${JSON.stringify(rpcMessage)}\n`)).pipe(
            Effect.asVoid,
          ),
        );
        const requestModelCatalogPage = Effect.fn(function* (cursor?: string) {
          requestId += 1;
          yield* sendRpcMessage({
            id: requestId,
            method: "model/list",
            params: { limit: 100, includeHidden: true, ...(cursor ? { cursor } : {}) },
          });
        });
        const processModelCatalogLine = Effect.fn(
          function* (line: string) {
            if (!line.trim()) return true;
            const response: unknown = yield* Effect.try({
              try: () => JSON.parse(line),
              catch: (error) => error,
            });
            if (!response || typeof response !== "object")
              return yield* Effect.fail(new PassesError("invalid JSON-RPC message"));
            const rpc = response as Record<string, unknown>;
            if (rpc.id !== requestId) return true;
            if (rpc.error)
              return yield* Effect.fail(
                new PassesError(JSON.stringify(rpc.error), { cause: rpc.error }),
              );
            if (!("result" in rpc))
              return yield* Effect.fail(new PassesError("response has no result"));
            if (!initialized) {
              initialized = true;
              yield* sendRpcMessage({ method: "initialized", params: {} });
              yield* requestModelCatalogPage();
              return true;
            }
            const catalogPage = yield* Schema.decodeUnknownEffect(ModelCatalogPage)(rpc.result);
            catalogModels.push(...catalogPage.data);
            if (catalogPage.nextCursor) {
              if (seenCatalogCursors.has(catalogPage.nextCursor))
                return yield* Effect.fail(new PassesError("server repeated its pagination cursor"));
              seenCatalogCursors.add(catalogPage.nextCursor);
              if (seenCatalogCursors.size > 100)
                return yield* Effect.fail(new PassesError("catalog exceeded 100 pages"));
              yield* requestModelCatalogPage(catalogPage.nextCursor);
              return true;
            }
            if (!catalogModels.length)
              return yield* Effect.fail(
                new PassesError(
                  "server returned no models; check Codex installation/provider configuration",
                ),
              );
            completedCatalog = [...catalogModels];
            return false;
          },
          Effect.mapError(
            (cause) =>
              new PassesError(
                `Codex model catalog: ${message(cause)}${stderr ? `\n${stderr.trim()}` : ""}`,
                { cause },
              ),
          ),
        );
        const processModelCatalogChunk = Effect.fn(function* (chunk: string) {
          pendingResponseLine += chunk;
          let newline = pendingResponseLine.indexOf("\n");
          while (newline >= 0) {
            const line = pendingResponseLine.slice(0, newline);
            pendingResponseLine = pendingResponseLine.slice(newline + 1);
            if (!(yield* processModelCatalogLine(line))) return false;
            newline = pendingResponseLine.indexOf("\n");
          }
          if (pendingResponseLine.length > 1_048_576)
            return yield* Effect.fail(
              new PassesError("Codex model catalog: response exceeded 1 MiB without a newline"),
            );
          return true;
        });
        const stdoutFiber = yield* proc.stdout.pipe(
          Stream.decodeText,
          Stream.runForEachWhile(processModelCatalogChunk),
          Effect.forkScoped,
        );
        yield* sendRpcMessage({
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "passes_runner", title: "Passes Runner", version: "0.1.0" },
            capabilities: { explicitGatewayOauth: true },
          },
        });
        yield* Fiber.join(stdoutFiber);
        if (completedCatalog) return completedCatalog;
        return yield* Effect.fail(
          new PassesError("Codex model catalog: app-server exited before returning a catalog"),
        );
      }),
    ),
  Effect.timeout("15 seconds"),
  Effect.mapError(
    (cause) =>
      new PassesError(`Could not check Codex model compatibility: ${message(cause)}`, { cause }),
  ),
);

export const checkCodexCompatibility = Effect.fn("Codex.checkCodexCompatibility")(function* (
  plan: Plan,
  fastModeRequested = false,
) {
  if (process.platform === "win32")
    return yield* Effect.fail(
      new PassesError(
        "passes currently supports macOS and Linux; safe process-group cancellation requires POSIX.",
      ),
    );
  const version = yield* runCommand("codex", ["--version"], plan.invocationDirectory);
  const match = /codex(?:-cli)?\s+(\d+)\.(\d+)\.(\d+)/.exec(version.stdout);
  if (version.code !== 0 || !match)
    return yield* Effect.fail(
      new PassesError(
        `Could not determine Codex CLI version. Install Codex CLI 0.159.2 or newer. ${version.stderr.trim()}`,
      ),
    );
  const major = Number(match[1]);
  const minor = Number(match[2]);
  const patch = Number(match[3]);
  if (major === 0 && (minor < 159 || (minor === 159 && patch < 2)))
    return yield* Effect.fail(
      new PassesError(
        `Codex ${match[0]} is too old. Install Codex CLI 0.159.2 or newer for the verified model-catalog protocol and execution flags.`,
      ),
    );
  const catalog = yield* loadModelCatalog(plan.invocationDirectory, fastModeRequested);
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
    return yield* Effect.fail(
      new PassesError(
        `Model compatibility check failed:\n${errors.map((error) => `  ${error}`).join("\n")}`,
      ),
    );
  return catalog;
});
