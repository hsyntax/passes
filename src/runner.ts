import { Effect, Fiber, Stream } from "effect";
import { execArgs, preflight } from "./codex.ts";
import { message, PassesError } from "./errors.ts";
import { lineReporter, startProcess } from "./process.ts";
import type { Plan, Stage } from "./stages.ts";

export interface Reporter {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
}

const runStage = Effect.fnUntraced(
  function* (stage: Stage, cwd: string, reporter: Reporter) {
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
    const out = yield* proc.stdout.pipe(
      Stream.runForEach((chunk) => Effect.sync(() => stdout.data(chunk))),
      Effect.forkScoped,
    );
    const err = yield* proc.stderr.pipe(
      Stream.runForEach((chunk) => Effect.sync(() => stderr.data(chunk))),
      Effect.forkScoped,
    );
    const drain = Effect.all([Fiber.join(out), Fiber.join(err)], { concurrency: "unbounded" });
    // Run before forkScoped finalizers so output still drains during termination.
    yield* Effect.addFinalizer(() =>
      proc.stop.pipe(
        Effect.andThen(drain.pipe(Effect.timeout(1_000), Effect.interruptible, Effect.ignore)),
      ),
    );
    // Early process exit can close stdin; report the process outcome in that case.
    yield* Stream.run(Stream.make(new TextEncoder().encode(stage.prompt)), proc.stdin).pipe(
      Effect.catchIf(
        (error) => {
          const code = (error.cause as NodeJS.ErrnoException | undefined)?.code;
          return (
            code === "EPIPE" ||
            code === "ERR_STREAM_DESTROYED" ||
            code === "ERR_STREAM_PREMATURE_CLOSE"
          );
        },
        () => Effect.void,
      ),
    );
    const code = yield* proc.exitCode;
    if (code !== 0)
      return yield* new PassesError({
        message: `${stage.name} (${stage.file}): failed with exit code ${code}`,
      });
    yield* drain.pipe(
      Effect.timeout(1_000),
      Effect.catchTag("TimeoutError", (cause) =>
        Effect.fail(
          new PassesError({
            message: `${stage.name}: Codex exited but a descendant kept its output pipe open; cancelling the process group`,
            cause,
          }),
        ),
      ),
    );
    stdout.end();
    stderr.end();
    yield* Effect.sync(() => reporter.out(`${stage.name}: completed`));
  },
  Effect.scoped,
  (effect, stage, _cwd, reporter) =>
    effect.pipe(
      Effect.mapError((error) =>
        error instanceof PassesError
          ? error
          : new PassesError({
              message: `${stage.name} (${stage.file}): ${message(error)}`,
              cause: error,
            }),
      ),
      Effect.tapError((error) => Effect.sync(() => reporter.err(error.message))),
      Effect.onInterrupt(() => Effect.sync(() => reporter.err(`${stage.name}: cancelled`))),
    ),
);

export const runPlan = Effect.fnUntraced(function* (plan: Plan, reporter: Reporter) {
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
    yield* Effect.forEach(layer.stages, (stage) => runStage(stage, plan.cwd, reporter), {
      concurrency: "unbounded",
      discard: true,
    });
  }
  yield* Effect.sync(() => reporter.out(`Finished: ${plan.stages.length} stages completed`));
});
