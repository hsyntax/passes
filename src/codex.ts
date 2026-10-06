import { Effect, Schema } from "effect";
import { message, PassesError } from "./errors.ts";
import { collectProcess, startProcess } from "./process.ts";
import type { Plan, Stage } from "./stages.ts";

const ModelCatalogEntry = Schema.Struct({
  model: Schema.NonEmptyString,
  supportedReasoningEfforts: Schema.Array(
    Schema.Struct({ reasoningEffort: Schema.NonEmptyString }),
  ),
});
const ModelCatalogPage = Schema.Struct({
  data: Schema.Array(ModelCatalogEntry),
  nextCursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
});
export type CatalogModel = typeof ModelCatalogEntry.Type;

export function stagePrompt(stage: Stage, scopeOverride?: string): string {
  const scope = scopeOverride ?? stage.scope;
  const prefix = scope === undefined ? "" : `Scope: ${scope}\n\n`;
  return `${prefix}${stage.prompt}\n\nAfter completing the stage, inspect your changes and commit them. Use a short subject describing the outcome. In the body, explain why and show a compact Before → After sketch when useful. Record only checks actually run. Skip empty commits.\n`;
}

export function execArgs(stage: Stage, cwd: string): string[] {
  return [
    "exec",
    "--approve-for-me",
    "--model",
    stage.model,
    "-c",
    `model_reasoning_effort=${JSON.stringify(stage.reasoning_effort)}`,
    "--cd",
    cwd,
    "--color",
    "never",
    "--ephemeral",
    "-",
  ];
}

export const loadModelCatalog = Effect.fn("Codex.loadModelCatalog")((cwd: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const proc = yield* startProcess("codex", ["app-server", "--listen", "stdio://"], cwd);
      return yield* Effect.callback<readonly CatalogModel[], PassesError>((resume) => {
        let pending = "";
        let stderr = "";
        let finished = false;
        let requestId = 1;
        let initialized = false;
        const catalogModels: CatalogModel[] = [];
        const cursors = new Set<string>();
        const finishCatalogLoad = (
          catalogLoad: Effect.Effect<readonly CatalogModel[], PassesError>,
        ) => {
          if (finished) return;
          finished = true;
          resume(catalogLoad);
        };
        const failCatalogLoad = (error: unknown) =>
          finishCatalogLoad(
            Effect.fail(
              new PassesError(
                `Codex model catalog: ${message(error)}${stderr ? `\n${stderr.trim()}` : ""}`,
              ),
            ),
          );
        const sendRpcRequest = (request: object) => {
          proc.child.stdin.write(`${JSON.stringify(request)}\n`);
        };
        const requestModelCatalogPage = (cursor?: string) => {
          requestId += 1;
          sendRpcRequest({
            id: requestId,
            method: "model/list",
            params: { limit: 100, includeHidden: true, ...(cursor ? { cursor } : {}) },
          });
        };
        const processModelCatalogResponse = (line: string) => {
          if (finished || !line.trim()) return;
          try {
            const response: unknown = JSON.parse(line);
            if (!response || typeof response !== "object")
              throw new Error("invalid JSON-RPC message");
            const rpc = response as Record<string, unknown>;
            if (rpc.id !== requestId) return; // Notifications and unrelated responses are not catalog results.
            if (rpc.error) throw new Error(JSON.stringify(rpc.error));
            if (!("result" in rpc)) throw new Error("response has no result");
            if (!initialized) {
              initialized = true;
              sendRpcRequest({ method: "initialized", params: {} });
              requestModelCatalogPage();
              return;
            }
            const catalogPage = Schema.decodeUnknownSync(ModelCatalogPage)(rpc.result);
            catalogModels.push(...catalogPage.data);
            if (catalogPage.nextCursor) {
              if (cursors.has(catalogPage.nextCursor))
                throw new Error("server repeated its pagination cursor");
              cursors.add(catalogPage.nextCursor);
              if (cursors.size > 100) throw new Error("catalog exceeded 100 pages");
              requestModelCatalogPage(catalogPage.nextCursor);
            } else if (!catalogModels.length) {
              throw new Error(
                "server returned no models; check Codex installation/provider configuration",
              );
            } else finishCatalogLoad(Effect.succeed(catalogModels));
          } catch (error) {
            failCatalogLoad(error);
          }
        };
        // setEncoding preserves split Unicode characters across chunks.
        proc.child.stdout.setEncoding("utf8");
        const onData = (chunk: string) => {
          pending += chunk;
          let newline = pending.indexOf("\n");
          while (newline >= 0) {
            processModelCatalogResponse(pending.slice(0, newline));
            pending = pending.slice(newline + 1);
            newline = pending.indexOf("\n");
          }
          if (pending.length > 1_048_576)
            failCatalogLoad("response exceeded 1 MiB without a newline");
        };
        const onStderr = (chunk: Buffer) => {
          stderr = (stderr + chunk.toString()).slice(-8_000);
        };
        proc.child.stdout.on("data", onData);
        proc.child.stderr.on("data", onStderr);
        void proc.exit.then(
          (processExit) =>
            failCatalogLoad(
              `app-server exited before returning a catalog (${processExit.code ?? processExit.signal})`,
            ),
          failCatalogLoad,
        );
        sendRpcRequest({
          id: 1,
          method: "initialize",
          params: {
            clientInfo: { name: "passes_runner", title: "Passes Runner", version: "0.1.0" },
            capabilities: { explicitGatewayOauth: true },
          },
        });
        return Effect.sync(() => {
          finished = true;
          proc.child.stdout.removeListener("data", onData);
          proc.child.stderr.removeListener("data", onStderr);
        });
      }).pipe(
        Effect.timeout(15_000),
        Effect.mapError(
          (error) =>
            new PassesError(`Could not check Codex model compatibility: ${message(error)}`),
        ),
      );
    }),
  ),
);

export const preflight = Effect.fn("Codex.preflight")((plan: Plan) =>
  Effect.gen(function* () {
    if (process.platform === "win32")
      return yield* Effect.fail(
        new PassesError(
          "passes currently supports macOS and Linux; safe process-group cancellation requires POSIX.",
        ),
      );
    const git = yield* collectProcess("git", ["rev-parse", "--is-inside-work-tree"], plan.cwd);
    if (git.code !== 0 || git.stdout.trim() !== "true")
      return yield* Effect.fail(
        new PassesError(
          "Run passes from inside the existing Git checkout you want to work on. No repository is created or switched.",
        ),
      );
    const version = yield* collectProcess("codex", ["--version"], plan.cwd);
    const match = /codex(?:-cli)?\s+(\d+)\.(\d+)\.(\d+)/.exec(version.stdout);
    if (version.code !== 0 || !match)
      return yield* Effect.fail(
        new PassesError(
          `Could not determine Codex CLI version. Install Codex CLI 0.159.2 or newer. ${version.stderr.trim()}`,
        ),
      );
    const [major, minor, patch] = match.slice(1).map(Number);
    if (major === 0 && ((minor ?? 0) < 159 || (minor === 159 && (patch ?? 0) < 2)))
      return yield* Effect.fail(
        new PassesError(
          `Codex ${match[0]} is too old. Install Codex CLI 0.159.2 or newer for the verified model-catalog protocol and execution flags.`,
        ),
      );
    const catalog = yield* loadModelCatalog(plan.cwd);
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
  }),
);
