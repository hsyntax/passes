import { Effect, Fiber, Stream } from "effect";
import { buildCodexExecArgs, checkCodexCompatibility, stagePrompt } from "./codex.ts";
import { message, PassesError } from "./errors.ts";
import { createLineReporter, runCommand, startProcess, waitForExit } from "./process.ts";
import type { Reporter } from "./reporter.ts";
import type { Plan, Stage } from "./stages.ts";

const MAX_CONCURRENT_STAGES = 4;

const runStage = Effect.fn("Runner.runStage")(
  (
    stage: Stage,
    invocationDirectory: string,
    reporter: Reporter,
    scopeOverride?: string,
    fast = false,
  ) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* reporter.out(`${stage.name}: starting`);
        const stdout = createLineReporter((line) => reporter.detail(`[${stage.name}] ${line}`));
        const stderr = createLineReporter((line) =>
          reporter.detail(`[${stage.name} stderr] ${line}`, "stderr"),
        );
        // Register first so process termination/draining runs before the final line flush.
        yield* Effect.addFinalizer(() =>
          Effect.all([stdout.end(), stderr.end()], { discard: true }).pipe(
            Effect.catch(() => Effect.void),
          ),
        );
        const proc = yield* startProcess(
          "codex",
          buildCodexExecArgs(stage, invocationDirectory, fast),
          invocationDirectory,
          stagePrompt(stage, scopeOverride),
        );
        const stdoutFiber = yield* Effect.forkScoped(
          Stream.decodeText(proc.stdout).pipe(Stream.runForEach((chunk) => stdout.data(chunk))),
        );
        const stderrFiber = yield* Effect.forkScoped(
          Stream.decodeText(proc.stderr).pipe(Stream.runForEach((chunk) => stderr.data(chunk))),
        );
        const processExit = yield* waitForExit(proc);
        yield* Effect.all([Fiber.join(stdoutFiber), Fiber.join(stderrFiber)]).pipe(
          Effect.timeout("1 second"),
          Effect.mapError(
            (cause) =>
              new PassesError(
                `${stage.name}: Codex exited but a descendant kept its output pipe open; cancelling the process group`,
                { cause },
              ),
          ),
        );
        if (processExit !== 0)
          return yield* Effect.fail(
            new PassesError(`${stage.name} (${stage.file}): failed with exit code ${processExit}`),
          );
        yield* stdout.end();
        yield* stderr.end();
        yield* reporter.out(`${stage.name}: completed`);
      }),
    ).pipe(
      Effect.tapError((error) => reporter.err(message(error))),
      Effect.onInterrupt(() => reporter.err(`${stage.name}: cancelled`)),
    ),
);

const pushPendingCommits = Effect.fn("Runner.pushPendingCommits")(
  (invocationDirectory: string, reporter: Reporter) =>
    Effect.scoped(
      Effect.gen(function* () {
        const remotes = yield* runCommand("git", ["remote"], invocationDirectory);
        if (remotes.code !== 0)
          return yield* Effect.fail(
            new PassesError(`Could not list Git remotes: ${remotes.stderr}`),
          );
        if (!remotes.stdout.trim()) {
          yield* reporter.out("No Git remote configured; skipping push.");
          return;
        }
        yield* reporter.out("All stages completed; pushing commits...");
        const stdout = createLineReporter((line) => reporter.detail(`[git push] ${line}`));
        const stderr = createLineReporter((line) =>
          reporter.detail(`[git push stderr] ${line}`, "stderr"),
        );
        yield* Effect.addFinalizer(() =>
          Effect.all([stdout.end(), stderr.end()], { discard: true }).pipe(
            Effect.catch(() => Effect.void),
          ),
        );
        const proc = yield* startProcess(
          "git",
          ["-c", "push.autoSetupRemote=true", "push"],
          invocationDirectory,
        );
        const stdoutFiber = yield* Effect.forkScoped(
          Stream.decodeText(proc.stdout).pipe(Stream.runForEach((chunk) => stdout.data(chunk))),
        );
        const stderrFiber = yield* Effect.forkScoped(
          Stream.decodeText(proc.stderr).pipe(Stream.runForEach((chunk) => stderr.data(chunk))),
        );
        const processExit = yield* waitForExit(proc);
        yield* Effect.all([Fiber.join(stdoutFiber), Fiber.join(stderrFiber)]).pipe(
          Effect.timeout("1 second"),
          Effect.mapError(
            (cause) =>
              new PassesError(
                "git push exited but a descendant kept its output pipe open; check the remote before retrying.",
                { cause },
              ),
          ),
        );
        if (processExit !== 0)
          return yield* Effect.fail(
            new PassesError(
              `git push failed with exit code ${processExit}; local commits are retained.`,
            ),
          );
        yield* reporter.out("Git push completed.");
      }),
    ),
);

export const runPlan = Effect.fn("Runner.runPlan")(
  (plan: Plan, reporter: Reporter, scopeOverride?: string, fast = false) =>
    Effect.gen(function* () {
      const catalog = yield* checkCodexCompatibility(plan, fast);
      const fastModels = new Set(
        catalog
          .filter(
            (model) =>
              fast &&
              (model.serviceTiers?.some((tier) => tier.id === "priority" || tier.id === "fast") ||
                (!model.serviceTiers?.length && model.additionalSpeedTiers?.includes("fast"))),
          )
          .map((model) => model.model),
      );
      if (fast) {
        for (const model of new Set(plan.stages.map((stage) => stage.model))) {
          yield* reporter.out(
            fastModels.has(model)
              ? `${model}: fast mode requested.`
              : `${model}: fast mode not advertised; using Codex defaults.`,
          );
        }
      }
      yield* reporter.out(
        "Model/effort catalog check passed; live access and quota are checked by Codex during execution.",
      );
      for (const layer of plan.layers) {
        yield* reporter.out(
          `Step ${layer.step}: starting ${layer.stages.length} stage${layer.stages.length === 1 ? "" : "s concurrently"}`,
        );
        // Effect interrupts sibling fibers and waits for their scoped process cleanup on failure.
        yield* Effect.forEach(
          layer.stages,
          (stage) =>
            runStage(
              stage,
              plan.invocationDirectory,
              reporter,
              scopeOverride,
              fastModels.has(stage.model),
            ),
          {
            concurrency: MAX_CONCURRENT_STAGES,
            discard: true,
          },
        );
      }
      const head = yield* runCommand(
        "git",
        ["log", "-1", "--format=%h %s"],
        plan.invocationDirectory,
      );
      yield* reporter.out(
        head.code === 0 ? `Latest commit: ${head.stdout.trim()}` : "No commit available.",
      );
      yield* pushPendingCommits(plan.invocationDirectory, reporter);
      yield* reporter.out(`Finished: ${plan.stages.length} stages completed`);
    }),
);
