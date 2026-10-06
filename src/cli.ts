#!/usr/bin/env bun
import { BunServices } from "@effect/platform-bun";
import { Cause, DateTime, Effect, Exit, Stdio } from "effect";
import { message, PassesError } from "./errors.ts";
import { runCommand } from "./process.ts";
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
let activeRunReporter: RunReporter | undefined;
let runLogWriteFailure: PassesError | undefined;

const main = Effect.fn("Cli.main")(() =>
  Effect.scoped(
    Effect.gen(function* () {
      const args = yield* Stdio.Stdio.use(({ args }) => args);
      if (args.length === 1 && args[0] === "--help") {
        yield* reporter.out(HELP);
        return;
      }
      if (args.length === 1 && args[0] === "--version") {
        yield* reporter.out("passes 0.1.0");
        return;
      }
      const positionalArguments: string[] = [];
      let scopeOverride: string | undefined;
      let verbose = false;
      let fastMode = false;
      for (let index = 0; index < args.length; index += 1) {
        const argument = args[index]!;
        if (argument === "--fast") {
          if (fastMode)
            return yield* Effect.fail(new PassesError("--fast may be supplied only once"));
          fastMode = true;
          continue;
        }
        if (argument === "--verbose") {
          if (verbose)
            return yield* Effect.fail(new PassesError("--verbose may be supplied only once"));
          verbose = true;
          continue;
        }
        if (argument !== "--scope") {
          positionalArguments.push(argument);
          continue;
        }
        if (scopeOverride !== undefined)
          return yield* Effect.fail(new PassesError("--scope may be supplied only once"));
        scopeOverride = yield* parseScope(args[index + 1]).pipe(
          Effect.mapError((cause) => new PassesError(`--scope: ${message(cause)}`, { cause })),
        );
        index += 1;
      }
      const [cliCommand, stagesDirectory] = positionalArguments;
      if (
        positionalArguments.length !== 2 ||
        (cliCommand !== "run" && cliCommand !== "validate") ||
        !stagesDirectory ||
        stagesDirectory.startsWith("--")
      ) {
        return yield* Effect.fail(
          new PassesError(
            `Expected passes validate <stages-directory> or passes run <stages-directory>. Use --help for details.`,
          ),
        );
      }
      if (verbose && cliCommand !== "run")
        return yield* Effect.fail(new PassesError("--verbose is only supported by run"));
      if (fastMode && cliCommand !== "run")
        return yield* Effect.fail(new PassesError("--fast is only supported by run"));
      const invocationDirectory = yield* Effect.sync(() => process.cwd());
      const plan = yield* loadPlan(stagesDirectory, invocationDirectory);
      if (cliCommand === "validate") {
        yield* reporter.out(renderPlanGraph(plan));
        return;
      }
      // This also rejects bare repositories and Git metadata directories, before Codex starts.
      const repositoryRoot = yield* runCommand(
        "git",
        ["rev-parse", "--show-toplevel"],
        plan.invocationDirectory,
      );
      if (repositoryRoot.code !== 0)
        return yield* Effect.fail(
          new PassesError("Run passes from inside an existing Git checkout."),
        );
      const runReporter = yield* createRunReporter(
        repositoryRoot.stdout.trim(),
        verbose,
        (error) => {
          runLogWriteFailure = error;
          queueMicrotask(() => interrupt());
        },
      ).pipe(
        Effect.mapError(
          (cause) => new PassesError(`Could not create run log: ${message(cause)}`, { cause }),
        ),
      );
      activeRunReporter = runReporter;
      reporter = runReporter.reporter;
      yield* reporter.out(`Log: ${runReporter.path}`);
      const runStartedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
      yield* runReporter.context(`Started: ${runStartedAt}\n${renderPlanGraph(plan)}`);
      yield* runPlan(plan, runReporter.reporter, scopeOverride, fastMode);
    }).pipe(
      Effect.onExit((exit) =>
        Effect.gen(function* () {
          if (runLogWriteFailure) {
            process.exitCode = 1;
            yield* terminal.err(`passes: ${runLogWriteFailure.message}`);
          } else if (interrupted) process.exitCode = interrupted === "SIGINT" ? 130 : 143;
          else if (Exit.isFailure(exit)) {
            process.exitCode = 1;
            yield* reporter.err(`passes: ${message(Cause.squash(exit.cause))}`);
          }
          if (activeRunReporter) yield* activeRunReporter.finish(Boolean(process.exitCode));
        }),
      ),
    ),
  ),
);

let interrupted: NodeJS.Signals | undefined;
const cancelRun = (signal: NodeJS.Signals) => {
  if (interrupted) return;
  interrupted = signal;
  interruptNotice(`${signal}: cancelling active stages...`);
  interrupt();
};
const sigint = () => cancelRun("SIGINT");
const sigterm = () => cancelRun("SIGTERM");
process.on("SIGINT", sigint);
process.on("SIGTERM", sigterm);
// A closed stdout pipe should also cancel descendants, rather than orphaning them.
const handleOutputError = (error: NodeJS.ErrnoException) => {
  if (error.code === "EPIPE") cancelRun("SIGTERM");
  else throw error;
};
process.stdout.on("error", handleOutputError);
process.stderr.on("error", handleOutputError);
const interrupt = Effect.runCallback(main().pipe(Effect.provide(BunServices.layer)), {
  onExit: (exit) => {
    process.removeListener("SIGINT", sigint);
    process.removeListener("SIGTERM", sigterm);
    process.stdout.removeListener("error", handleOutputError);
    process.stderr.removeListener("error", handleOutputError);
    if (Exit.isFailure(exit) && process.exitCode === undefined) process.exitCode = 1;
  },
});
