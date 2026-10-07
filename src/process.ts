import { Effect, Fiber, Stream } from "effect";
import * as ChildProcess from "effect/process/ChildProcess";
import type { ChildProcessHandle } from "effect/process/ChildProcessSpawner";
import type * as PlatformError from "effect/PlatformError";
import { message, PassesError } from "./errors.ts";

const FORCE_KILL_AFTER = "500 millis";

export const startProcess = Effect.fn(
  (
    command: string,
    args: readonly string[],
    workingDirectory: string,
    input?: string | Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  ) =>
    // The platform spawner owns scoped process-group cleanup, including escalation
    // after the leader exits. Keep the deadline on the command it releases.
    ChildProcess.make(command, [...args], {
      cwd: workingDirectory,
      detached: true,
      forceKillAfter: FORCE_KILL_AFTER,
      stdin:
        input === undefined
          ? "ignore"
          : typeof input === "string"
            ? Stream.make(new TextEncoder().encode(input))
            : input,
      stdout: "pipe",
      stderr: "pipe",
    }).pipe(
      Effect.mapError(
        (cause) => new PassesError(`Could not start ${command}: ${message(cause)}`, { cause }),
      ),
    ),
);

export const waitForExit = Effect.fn("Process.waitForExit")((proc: ChildProcessHandle) =>
  proc.exitCode.pipe(Effect.mapError((cause) => new PassesError(message(cause), { cause }))),
);

export const runCommand = Effect.fn("Process.runCommand")(
  (command: string, args: readonly string[], workingDirectory: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const proc = yield* startProcess(command, args, workingDirectory);
        const stdoutFiber = yield* proc.stdout.pipe(
          Stream.decodeText,
          Stream.runFold(
            () => "",
            (contents, chunk) => (contents + chunk).slice(-64_000),
          ),
          Effect.forkScoped,
        );
        const stderrFiber = yield* proc.stderr.pipe(
          Stream.decodeText,
          Stream.runFold(
            () => "",
            (contents, chunk) => (contents + chunk).slice(-8_000),
          ),
          Effect.forkScoped,
        );
        const code = yield* waitForExit(proc);
        // Descendants can inherit pipes after the leader exits. Bound the drain;
        // scope cleanup then terminates the group through the platform adapter.
        const [stdout, stderr] = yield* Effect.all([
          Fiber.join(stdoutFiber),
          Fiber.join(stderrFiber),
        ]).pipe(
          Effect.timeout("1 second"),
          Effect.mapError(
            (error) =>
              new PassesError(`${command}: ${message(error)} while draining child process output`, {
                cause: error,
              }),
          ),
        );
        return { code, stdout, stderr };
      }),
    ).pipe(
      Effect.timeout("10 seconds"),
      Effect.mapError((cause) => new PassesError(`${command}: ${message(cause)}`, { cause })),
    ),
);

/** Prefix streamed process output while bounding the memory used for a line. */
export function createLineReporter<E, R>(write: (line: string) => Effect.Effect<void, E, R>) {
  let pending = "";
  // These callbacks consume the buffer at call time. Effect.fn would defer that
  // mutation until execution, changing which call owns each batch of lines.
  function flush(full: boolean): Effect.Effect<void, E, R> {
    const lines: string[] = [];
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      lines.push(pending.slice(0, newline).replace(/\r$/, ""));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
    while (pending.length > 8_192) {
      lines.push(pending.slice(0, 8_192));
      pending = pending.slice(8_192);
    }
    if (full && pending) {
      lines.push(pending);
      pending = "";
    }
    return Effect.forEach(lines, write, { discard: true });
  }
  return {
    data: (chunk: string): Effect.Effect<void, E, R> => {
      pending += chunk;
      return flush(false);
    },
    end: (): Effect.Effect<void, E, R> => flush(true),
  };
}
