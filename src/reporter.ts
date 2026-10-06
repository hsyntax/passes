import { Effect, FileSystem, Path, Semaphore, Stdio, Stream } from "effect";
import { homedir } from "node:os";
import { message, PassesError } from "./errors.ts";

export interface Reporter {
  readonly out: (line: string) => Effect.Effect<void, PassesError, Stdio.Stdio>;
  readonly err: (line: string) => Effect.Effect<void, PassesError, Stdio.Stdio>;
  readonly detail: (
    line: string,
    stream?: "stdout" | "stderr",
  ) => Effect.Effect<void, PassesError, Stdio.Stdio>;
}

export interface RunReporter {
  readonly reporter: Reporter;
  readonly path: string;
  readonly context: (line: string) => Effect.Effect<void, PassesError, Stdio.Stdio>;
  readonly finish: (unsuccessful: boolean) => Effect.Effect<void, PassesError, Stdio.Stdio>;
}

const writeTerminal = Effect.fn((line: string, stream: "stdout" | "stderr") =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    yield* Stream.run(
      Stream.make(`${line}\n`),
      stream === "stderr" ? stdio.stderr() : stdio.stdout(),
    ).pipe(
      Effect.mapError(
        (cause) => new PassesError(`Could not write to ${stream}: ${message(cause)}`, { cause }),
      ),
    );
  }),
);

export const terminal: Reporter = {
  out: (line) => writeTerminal(line, "stdout"),
  err: (line) => writeTerminal(line, "stderr"),
  detail: () => Effect.void,
};

export function interruptNotice(line: string): void {
  process.stderr.write(`${line}\n`);
}

export const createRunReporter = Effect.fn("Reporter.createRunReporter")(
  (checkoutRoot: string, verbose: boolean, onFailure: (error: PassesError) => void) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* Effect.sync(homedir);
      const stateHome = process.env.XDG_STATE_HOME || path.join(home, ".local", "state");
      if (!path.isAbsolute(stateHome))
        return yield* Effect.fail(new PassesError("XDG_STATE_HOME must be an absolute path"));
      const logDirectory = path.join(stateHome, "passes", "runs");

      // Resolve the closest existing ancestor so symlinks cannot place logs in the checkout.
      let ancestor = logDirectory;
      while (!(yield* fs.exists(ancestor))) {
        const parent = path.dirname(ancestor);
        if (parent === ancestor)
          return yield* Effect.fail(
            new PassesError(`Could not resolve log directory ${logDirectory}`),
          );
        ancestor = parent;
      }
      const resolvedAncestor = yield* fs.realPath(ancestor);
      const resolvedLogDirectory = path.resolve(
        resolvedAncestor,
        path.relative(ancestor, logDirectory),
      );
      const resolvedCheckoutRoot = yield* fs.realPath(checkoutRoot);
      const relativeLogDirectory = path.relative(resolvedCheckoutRoot, resolvedLogDirectory);
      if (
        relativeLogDirectory === "" ||
        (!path.isAbsolute(relativeLogDirectory) &&
          relativeLogDirectory !== ".." &&
          !relativeLogDirectory.startsWith(`..${path.sep}`))
      )
        return yield* Effect.fail(
          new PassesError("Log directory is inside the checkout; set XDG_STATE_HOME outside it"),
        );

      yield* fs.makeDirectory(logDirectory, { recursive: true, mode: 0o700 });
      const logPath = path.join(
        logDirectory,
        `${new Date().toISOString().replaceAll(":", "-")}-${crypto.randomUUID()}.log`,
      );
      const logFile = yield* fs.open(logPath, { flag: "wx", mode: 0o600 });
      const lock = yield* Semaphore.make(1);
      let logWriteFailed = false;
      let recentOutput = "";

      const reportLogFailure = (error: unknown) => {
        if (logWriteFailed) return;
        logWriteFailed = true;
        onFailure(
          new PassesError(`Could not write run log ${logPath}: ${message(error)}`, {
            cause: error,
          }),
        );
      };
      const writeLogLine = Effect.fn((line: string, includeRecentOutput = false) =>
        lock.withPermit(
          Effect.gen(function* () {
            if (!logWriteFailed)
              yield* logFile
                .writeAll(new TextEncoder().encode(`${line}\n`))
                .pipe(Effect.catch((error) => Effect.sync(() => reportLogFailure(error))));
            if (includeRecentOutput)
              recentOutput = `${recentOutput}${line}\n`
                .slice(-8_000)
                .split("\n")
                .slice(-21)
                .join("\n");
          }),
        ),
      );
      const reporter: Reporter = {
        out: (line) => Effect.andThen(writeLogLine(line), terminal.out(line)),
        err: (line) => Effect.andThen(writeLogLine(line), terminal.err(line)),
        detail: (line, stream = "stdout") =>
          writeLogLine(line, true).pipe(
            Effect.andThen(
              verbose
                ? stream === "stderr"
                  ? terminal.err(line)
                  : terminal.out(line)
                : Effect.void,
            ),
          ),
      };

      return {
        reporter,
        path: logPath,
        context: (line: string) =>
          writeLogLine(line).pipe(Effect.andThen(verbose ? terminal.out(line) : Effect.void)),
        finish: (unsuccessful: boolean) =>
          Effect.gen(function* () {
            yield* logFile.sync.pipe(
              Effect.catch((error) => Effect.sync(() => reportLogFailure(error))),
            );
            if (unsuccessful && !verbose && recentOutput)
              yield* terminal.err(`Recent output:\n${recentOutput.trimEnd()}`);
            yield* terminal.out(`Log: ${logPath}`);
          }),
      };
    }),
);
