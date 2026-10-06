import { Effect } from "effect";
import { execArgs, preflight, stagePrompt } from "./codex.ts";
import { PassesError } from "./errors.ts";
import { lineReporter, startProcess, waitForExit } from "./process.ts";
import type { Plan, Stage } from "./stages.ts";

const MAX_CONCURRENT_STAGES = 4;

export interface Reporter {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

function runStage(stage: Stage, cwd: string, reporter: Reporter, scopeOverride?: string) {
  return Effect.scoped(
    Effect.gen(function* () {
      yield* Effect.sync(() => reporter.out(`${stage.name}: starting`));
      const stdout = lineReporter((line) => reporter.out(`[${stage.name}] ${line}`));
      const stderr = lineReporter((line) => reporter.err(`[${stage.name} stderr] ${line}`));
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
      const result = yield* waitForExit(proc);
      if (result.code !== 0)
        return yield* Effect.fail(
          new PassesError(
            `${stage.name} (${stage.file}): failed with ${result.signal ? `signal ${result.signal}` : `exit code ${result.code}`}`,
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
  );
}

export function runPlan(plan: Plan, reporter: Reporter, scopeOverride?: string) {
  return Effect.gen(function* () {
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
    yield* Effect.sync(() => reporter.out(`Finished: ${plan.stages.length} stages completed`));
  });
}
