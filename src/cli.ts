#!/usr/bin/env bun
import { Cause, Effect, Exit, Fiber } from "effect";
import { message, PassesError } from "./errors.ts";
import { runPlan } from "./runner.ts";
import { loadPlan, parseScope, renderGraph } from "./stages.ts";

const HELP = `passes 0.1.0

Usage:
  passes validate <stages-directory> [--scope <text>]
  passes run <stages-directory> [--scope <text>]
  passes --help
  passes --version

Markdown stages in the directory are discovered recursively (.md, no symlinks).
validate checks YAML and prints the layer graph without invoking Codex.
run validates, checks Codex's model catalog, then executes each layer.
--scope overrides stage scope and prepends a literal Scope: line to each prompt.
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
    const positional: string[] = [];
    let scope: string | undefined;
    for (let index = 0; index < args.length; index += 1) {
      const argument = args[index];
      if (argument !== "--scope") {
        if (argument !== undefined) positional.push(argument);
        continue;
      }
      if (scope !== undefined)
        return yield* Effect.fail(new PassesError("--scope may be supplied only once"));
      scope = yield* Effect.try({
        try: () => parseScope(args[index + 1]),
        catch: (error) => new PassesError(`--scope: ${message(error)}`),
      });
      index += 1;
    }
    const [command, directory] = positional;
    if (
      positional.length !== 2 ||
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
    if (command === "run") yield* runPlan(plan, reporter, scope);
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
