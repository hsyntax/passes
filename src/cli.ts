#!/usr/bin/env bun
import { Cause, Effect, Exit, Fiber } from "effect";
import { message, PassesError } from "./errors.ts";
import { runPlan } from "./runner.ts";
import { loadPlan, renderGraph } from "./stages.ts";

const HELP = `passes 0.1.0

Usage:
  passes validate <stages-directory>
  passes run <stages-directory>
  passes --help
  passes --version

Markdown stages in the directory are discovered recursively (.md, no symlinks).
validate checks YAML and prints the layer graph without invoking Codex.
run validates, checks Codex's model catalog, then executes each layer.
All agents use your invocation directory in its existing Git checkout.
Concurrent stages share files. No commits, worktrees, branches, or artifacts are managed.
Requires Bun >=1.3 and Codex CLI >=0.159.2; macOS/Linux for execution.
`;
const reporter = {
  out: (line: string) => {
    process.stdout.write(`${line}\n`);
  },
  err: (line: string) => {
    process.stderr.write(`${line}\n`);
  },
};

function main(args: readonly string[]) {
  return Effect.gen(function* () {
    if (args.length === 1 && args[0] === "--help") {
      yield* Effect.sync(() => reporter.out(HELP));
      return;
    }
    if (args.length === 1 && args[0] === "--version") {
      yield* Effect.sync(() => reporter.out("passes 0.1.0"));
      return;
    }
    const [command, directory] = args;
    if (
      args.length !== 2 ||
      (command !== "run" && command !== "validate") ||
      !directory ||
      directory.startsWith("--")
    ) {
      return yield* Effect.fail(
        new PassesError(
          `Expected passes validate <stages-directory> or passes run <stages-directory>. Use --help for details.`,
        ),
      );
    }
    const plan = yield* loadPlan(directory, process.cwd());
    yield* Effect.sync(() => reporter.out(renderGraph(plan)));
    if (command === "run") yield* runPlan(plan, reporter);
  });
}

let interrupted: NodeJS.Signals | undefined;
const fiber = Effect.runFork(main(process.argv.slice(2)));
const stop = (signal: NodeJS.Signals) => {
  if (interrupted) return;
  interrupted = signal;
  reporter.err(`${signal}: cancelling active stages...`);
  Effect.runFork(Fiber.interrupt(fiber));
};
const sigint = () => stop("SIGINT");
const sigterm = () => stop("SIGTERM");
process.on("SIGINT", sigint);
process.on("SIGTERM", sigterm);
// A closed stdout pipe should also cancel descendants, rather than orphaning them.
const outputError = (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") stop("SIGTERM");
  else throw error;
};
process.stdout.on("error", outputError);
process.stderr.on("error", outputError);
const exit = await Effect.runPromise(Fiber.await(fiber));
process.removeListener("SIGINT", sigint);
process.removeListener("SIGTERM", sigterm);
if (interrupted) process.exitCode = interrupted === "SIGINT" ? 130 : 143;
else if (Exit.isFailure(exit)) {
  reporter.err(`passes: ${message(Cause.squash(exit.cause))}`);
  process.exitCode = 1;
}
