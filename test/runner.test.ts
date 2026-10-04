import { expect, it } from "@effect/vitest";
import { Effect, PlatformError, Sink, Stream } from "effect";
import { ChildProcessSpawner } from "effect/process";
import { runPlan } from "../src/runner.ts";
import type { Plan } from "../src/stages.ts";

const stage = {
  name: "Review",
  slug: "review",
  step: 0,
  model: "mock-model",
  reasoning_effort: "medium",
  prompt: "Review the code",
  file: "review.md",
};
const plan: Plan = {
  cwd: "/workspace",
  directory: "/workspace/stages",
  stages: [stage],
  layers: [{ step: 0, stages: [stage] }],
};
const reporter = { out: () => {}, err: () => {} };
const bytes = (text: string) => Stream.make(new TextEncoder().encode(text));

// Inject I/O failures at the platform boundary; real pipes cannot reliably produce
// an arbitrary read/write error. CLI acceptance tests cover actual subprocesses.
function spawnerWithFailure(channel: "stdin" | "stdout", error: PlatformError.PlatformError) {
  return ChildProcessSpawner.make((command) => {
    if (command._tag !== "StandardCommand") return Effect.die("Unexpected pipeline");
    const catalog = command.args.includes("app-server");
    const exec = command.args.includes("exec");
    const stdout =
      command.command === "git"
        ? bytes("true\n")
        : command.args.includes("--version")
          ? bytes("codex-cli 0.159.2\n")
          : catalog
            ? bytes(
                [
                  JSON.stringify({ id: 1, result: {} }),
                  JSON.stringify({
                    id: 2,
                    result: {
                      data: [
                        {
                          model: "mock-model",
                          supportedReasoningEfforts: [{ reasoningEffort: "medium" }],
                        },
                      ],
                      nextCursor: null,
                    },
                  }),
                  "",
                ].join("\n"),
              )
            : exec && channel === "stdout"
              ? Stream.fail(error)
              : Stream.empty;
    return Effect.succeed(
      ChildProcessSpawner.makeHandle({
        pid: ChildProcessSpawner.ProcessId(1),
        exitCode: catalog ? Effect.never : Effect.succeed(ChildProcessSpawner.ExitCode(0)),
        isRunning: Effect.succeed(catalog),
        kill: () => Effect.void,
        stdin: exec && channel === "stdin" ? Sink.fail(error) : Sink.drain,
        stdout,
        stderr: Stream.empty,
        all: stdout,
        getInputFd: () => Sink.drain,
        getOutputFd: () => Stream.empty,
        unref: Effect.succeed(Effect.void),
      }),
    );
  });
}

it.effect.each(["stdin", "stdout"] as const)("preserves unexpected %s failures", (channel) =>
  Effect.gen(function* () {
    const cause = PlatformError.systemError({
      _tag: "Unknown",
      module: "ChildProcess",
      method: channel,
      description: "device I/O failure",
      cause: Object.assign(new Error("device I/O failure"), { code: "EIO" }),
    });
    const error = yield* Effect.flip(
      runPlan(plan, reporter).pipe(
        Effect.provideService(
          ChildProcessSpawner.ChildProcessSpawner,
          spawnerWithFailure(channel, cause),
        ),
      ),
    );
    expect(error.message).toContain("device I/O failure");
    expect(error.message).not.toContain("descendant kept its output pipe open");
    expect(error.cause).toBe(cause);
  }),
);

it.effect("accepts an early stdin pipe closure when the process succeeds", () =>
  Effect.gen(function* () {
    const error = PlatformError.systemError({
      _tag: "Unknown",
      module: "ChildProcess",
      method: "stdin",
      cause: Object.assign(new Error("broken pipe"), { code: "EPIPE" }),
    });
    yield* runPlan(plan, reporter).pipe(
      Effect.provideService(
        ChildProcessSpawner.ChildProcessSpawner,
        spawnerWithFailure("stdin", error),
      ),
    );
  }),
);
