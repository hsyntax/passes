#!/usr/bin/env bun
import { Cause, Effect, Exit, Fiber } from "effect";
import type * as FileSystemService from "effect/FileSystem";
import type * as PathService from "effect/Path";
import type * as StdioService from "effect/Stdio";
import type { ChildProcessSpawner } from "effect/process/ChildProcessSpawner";
import { message, PassesError } from "./errors.ts";
import { runCommand, nodeProcessLayer } from "./process.ts";
import { createRunReporter, interruptNotice, terminal } from "./reporter.ts";
import type { Reporter, RunReporter } from "./reporter.ts";
import { runPlan } from "./runner.ts";
import { loadPlan, parseScope, renderPlanGraph } from "./stages.ts";

const HELP = `passes 0.1.0

Usage:
  passes validate <stages-directory> [--scope <text>]
  passes run <stages-directory> [--scope <text>] [--verbose] [--fast]
  passes --help
  passes --version

Markdown stages in the directory are discovered recursively (.md, no symlinks).
validate checks YAML and prints the layer graph without invoking Codex.
run validates, checks Codex's model catalog, executes each layer, then pushes if a remote exists.
--scope overrides stage scope and prepends a literal Scope: line to each prompt.
--fast requests fast mode for models that advertise support, preserving reasoning effort.
run saves output outside the checkout and prints progress; --verbose also streams stage output.
All agents use your invocation directory in its existing Git checkout.
Concurrent stages share files. The runner does not create commits, worktrees, or branches.
Requires Bun >=1.3 and Codex CLI >=0.159.2; macOS/Linux for execution.
`;
let reporter: Reporter = terminal;
let runLog: RunReporter | undefined;
let loggingFailure: PassesError | undefined;

function main(
  args: readonly string[],
): Effect.Effect<
  void,
  PassesError,
  ChildProcessSpawner | FileSystemService.FileSystem | PathService.Path | StdioService.Stdio
> {
  return Effect.scoped(
    Effect.gen(function* () {
      if (args.length === 1 && args[0] === "--help") {
        yield* reporter.out(HELP);
        return;
      }
      if (args.length === 1 && args[0] === "--version") {
        yield* reporter.out("passes 0.1.0");
        return;
      }
      const positional: string[] = [];
      let scope: string | undefined;
      let verbose = false;
      let fast = false;
      for (let index = 0; index < args.length; index += 1) {
        const argument = args[index];
        if (argument === "--fast") {
          if (fast) return yield* Effect.fail(new PassesError("--fast may be supplied only once"));
          fast = true;
          continue;
        }
        if (argument === "--verbose") {
          if (verbose)
            return yield* Effect.fail(new PassesError("--verbose may be supplied only once"));
          verbose = true;
          continue;
        }
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
      const [command, stagesDirectory] = positional;
      if (
        positional.length !== 2 ||
        (command !== "run" && command !== "validate") ||
        !stagesDirectory ||
        stagesDirectory.startsWith("--")
      ) {
        return yield* Effect.fail(
          new PassesError(
            `Expected passes validate <stages-directory> or passes run <stages-directory>. Use --help for details.`,
          ),
        );
      }
      if (verbose && command !== "run")
        return yield* Effect.fail(new PassesError("--verbose is only supported by run"));
      if (fast && command !== "run")
        return yield* Effect.fail(new PassesError("--fast is only supported by run"));
      const invocationDirectory = process.cwd();
      const plan = yield* loadPlan(stagesDirectory, invocationDirectory);
      if (command === "validate") {
        yield* reporter.out(renderPlanGraph(plan));
        return;
      }
      // This also rejects bare repositories and Git metadata directories, before Codex starts.
      const repository = yield* runCommand(
        "git",
        ["rev-parse", "--show-toplevel"],
        plan.invocationDirectory,
      );
      if (repository.code !== 0)
        return yield* Effect.fail(
          new PassesError("Run passes from inside an existing Git checkout."),
        );
      const log = yield* createRunReporter(repository.stdout.trim(), verbose, (error) => {
        loggingFailure = error;
        queueMicrotask(() => {
          Effect.runFork(Fiber.interrupt(fiber));
        });
      }).pipe(
        Effect.mapError((error) => new PassesError(`Could not create run log: ${message(error)}`)),
      );
      runLog = log;
      reporter = log.reporter;
      yield* reporter.out(`Log: ${log.path}`);
      yield* log.context(`Started: ${new Date().toISOString()}\n${renderPlanGraph(plan)}`);
      yield* runPlan(plan, log.reporter, scope, fast).pipe(
        Effect.mapError((error) => new PassesError(message(error))),
      );
    }).pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          if (loggingFailure) {
            process.exitCode = 1;
            yield* terminal.err(`passes: ${loggingFailure.message}`);
          } else if (interrupted) process.exitCode = interrupted === "SIGINT" ? 130 : 143;
          else if (Exit.isFailure(exit)) {
            process.exitCode = 1;
            yield* reporter.err(`passes: ${message(Cause.squash(exit.cause))}`);
          }
          if (runLog) yield* runLog.finish(Boolean(process.exitCode));
        }),
      ),
    ),
  );
}

let interrupted: NodeJS.Signals | undefined;
const fiber = Effect.runFork(main(process.argv.slice(2)).pipe(Effect.provide(nodeProcessLayer)));
const stop = (signal: NodeJS.Signals) => {
  if (interrupted) return;
  interrupted = signal;
  interruptNotice(`${signal}: cancelling active stages...`);
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
if (Exit.isFailure(exit) && process.exitCode === undefined) process.exitCode = 1;
