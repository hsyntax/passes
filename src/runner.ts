import { Effect } from "effect";
import { execArgs, preflight, stagePrompt } from "./codex.ts";
import { PassesError } from "./errors.ts";
import { collectProcess, createLineReporter, startProcess, waitForExit } from "./process.ts";
import type { Reporter } from "./reporter.ts";
import type { Plan, Stage } from "./stages.ts";

const MAX_CONCURRENT_STAGES = 4;

const runStage = Effect.fn("Runner.runStage")(
  (stage: Stage, cwd: string, reporter: Reporter, scopeOverride?: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        yield* Effect.sync(() => reporter.out(`${stage.name}: starting`));
        const stdout = createLineReporter((line) => reporter.detail(`[${stage.name}] ${line}`));
        const stderr = createLineReporter((line) =>
          reporter.detail(`[${stage.name} stderr] ${line}`, "stderr"),
        );
        // Register first so process termination/draining runs before the final line flush.
        yield* Effect.addFinalizer(() =>
          Effect.sync(() => {
            stdout.end();
            stderr.end();
          }),
        );
        const proc = yield* startProcess("codex", execArgs(stage, cwd), cwd);
        proc.child.stdout.on("data", stdout.data);
        proc.child.stderr.on("data", stderr.data);
        proc.child.stdin.end(stagePrompt(stage, scopeOverride));
        const processExit = yield* waitForExit(proc);
        if (processExit.code !== 0)
          return yield* Effect.fail(
            new PassesError(
              `${stage.name} (${stage.file}): failed with ${processExit.signal ? `signal ${processExit.signal}` : `exit code ${processExit.code}`}`,
            ),
          );
        // Drain final output, but never hang forever on a descendant holding the pipe open.
        yield* Effect.promise(() => proc.closed).pipe(
          Effect.timeout(1_000),
          Effect.mapError(
            () =>
              new PassesError(
                `${stage.name}: Codex exited but a descendant kept its output pipe open; cancelling the process group`,
              ),
          ),
        );
        stdout.end();
        stderr.end();
        yield* Effect.sync(() => reporter.out(`${stage.name}: completed`));
      }),
    ).pipe(
      Effect.tapError((error) => Effect.sync(() => reporter.err(error.message))),
      Effect.onInterrupt(() => Effect.sync(() => reporter.err(`${stage.name}: cancelled`))),
    ),
);

const pushCommits = Effect.fn("Runner.pushCommits")((cwd: string, reporter: Reporter) =>
  Effect.scoped(
    Effect.gen(function* () {
      const remotes = yield* collectProcess("git", ["remote"], cwd);
      if (remotes.code !== 0)
        return yield* Effect.fail(new PassesError(`Could not list Git remotes: ${remotes.stderr}`));
      if (!remotes.stdout.trim()) {
        yield* Effect.sync(() => reporter.out("No Git remote configured; skipping push."));
        return;
      }
      yield* Effect.sync(() => reporter.out("All stages completed; pushing commits..."));
      const stdout = createLineReporter((line) => reporter.detail(`[git push] ${line}`));
      const stderr = createLineReporter((line) =>
        reporter.detail(`[git push stderr] ${line}`, "stderr"),
      );
      yield* Effect.addFinalizer(() =>
        Effect.sync(() => {
          stdout.end();
          stderr.end();
        }),
      );
      const proc = yield* startProcess("git", ["-c", "push.autoSetupRemote=true", "push"], cwd);
      proc.child.stdout.on("data", stdout.data);
      proc.child.stderr.on("data", stderr.data);
      proc.child.stdin.end();
      const processExit = yield* waitForExit(proc);
      yield* Effect.promise(() => proc.closed).pipe(
        Effect.timeout(1_000),
        Effect.mapError(
          () =>
            new PassesError(
              "git push exited but a descendant kept its output pipe open; check the remote before retrying.",
            ),
        ),
      );
      if (processExit.code !== 0)
        return yield* Effect.fail(
          new PassesError(
            `git push failed with ${processExit.signal ? `signal ${processExit.signal}` : `exit code ${processExit.code}`}; local commits are retained.`,
          ),
        );
      yield* Effect.sync(() => reporter.out("Git push completed."));
    }),
  ),
);

export const runPlan = Effect.fn("Runner.runPlan")(
  (plan: Plan, reporter: Reporter, scopeOverride?: string) =>
    Effect.gen(function* () {
      yield* preflight(plan);
      yield* Effect.sync(() =>
        reporter.out(
          "Model/effort catalog check passed; live access and quota are checked by Codex during execution.",
        ),
      );
      for (const layer of plan.layers) {
        yield* Effect.sync(() =>
          reporter.out(
            `Step ${layer.step}: starting ${layer.stages.length} stage${layer.stages.length === 1 ? "" : "s concurrently"}`,
          ),
        );
        // Effect interrupts sibling fibers and waits for their scoped process cleanup on failure.
        yield* Effect.forEach(
          layer.stages,
          (stage) => runStage(stage, plan.cwd, reporter, scopeOverride),
          {
            concurrency: MAX_CONCURRENT_STAGES,
            discard: true,
          },
        );
      }
      const head = yield* collectProcess("git", ["log", "-1", "--format=%h %s"], plan.cwd);
      yield* Effect.sync(() =>
        reporter.out(
          head.code === 0 ? `Latest commit: ${head.stdout.trim()}` : "No commit available.",
        ),
      );
      yield* pushCommits(plan.cwd, reporter);
      yield* Effect.sync(() => reporter.out(`Finished: ${plan.stages.length} stages completed`));
    }),
);
