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
  (repository: string, verbose: boolean, onFailure: (error: PassesError) => void) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const home = yield* Effect.sync(homedir);
      const stateHome = process.env.XDG_STATE_HOME || path.join(home, ".local", "state");
      if (!path.isAbsolute(stateHome))
        return yield* Effect.fail(new PassesError("XDG_STATE_HOME must be an absolute path"));
      const directory = path.join(stateHome, "passes", "runs");

      // Resolve the closest existing ancestor so symlinks cannot place logs in the checkout.
      let ancestor = directory;
      while (!(yield* fs.exists(ancestor))) {
        const parent = path.dirname(ancestor);
        if (parent === ancestor)
          return yield* Effect.fail(
            new PassesError(`Could not resolve log directory ${directory}`),
          );
        ancestor = parent;
      }
      const resolvedAncestor = yield* fs.realPath(ancestor);
      const resolvedDirectory = path.resolve(resolvedAncestor, path.relative(ancestor, directory));
      const resolvedRepository = yield* fs.realPath(repository);
      const within = path.relative(resolvedRepository, resolvedDirectory);
      if (
        within === "" ||
        (!path.isAbsolute(within) && within !== ".." && !within.startsWith(`..${path.sep}`))
      )
        return yield* Effect.fail(
          new PassesError("Log directory is inside the checkout; set XDG_STATE_HOME outside it"),
        );

      yield* fs.makeDirectory(directory, { recursive: true, mode: 0o700 });
      const logPath = path.join(
        directory,
        `${new Date().toISOString().replaceAll(":", "-")}-${crypto.randomUUID()}.log`,
      );
      const file = yield* fs.open(logPath, { flag: "wx", mode: 0o600 });
      const lock = yield* Semaphore.make(1);
      let failed = false;
      let tail = "";

      const reportLogFailure = (error: unknown) => {
        if (failed) return;
        failed = true;
        onFailure(
          new PassesError(`Could not write run log ${logPath}: ${message(error)}`, {
            cause: error,
          }),
        );
      };
      const record = Effect.fn((line: string, includeTail = false) =>
        lock.withPermit(
          Effect.gen(function* () {
            if (!failed)
              yield* file
                .writeAll(new TextEncoder().encode(`${line}\n`))
                .pipe(Effect.catch((error) => Effect.sync(() => reportLogFailure(error))));
            if (includeTail)
              tail = `${tail}${line}\n`.slice(-8_000).split("\n").slice(-21).join("\n");
          }),
        ),
      );
      const reporter: Reporter = {
        out: (line) => Effect.andThen(record(line), terminal.out(line)),
        err: (line) => Effect.andThen(record(line), terminal.err(line)),
        detail: (line, stream = "stdout") =>
          record(line, true).pipe(
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
          record(line).pipe(Effect.andThen(verbose ? terminal.out(line) : Effect.void)),
        finish: (unsuccessful: boolean) =>
          Effect.gen(function* () {
            yield* file.sync.pipe(
              Effect.catch((error) => Effect.sync(() => reportLogFailure(error))),
            );
            if (unsuccessful && !verbose && tail)
              yield* terminal.err(`Recent output:\n${tail.trimEnd()}`);
            yield* terminal.out(`Log: ${logPath}`);
          }),
      };
    }),
);
