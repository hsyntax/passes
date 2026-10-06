import { layer as childProcessLayer } from "@effect/platform-node-shared/NodeChildProcessSpawner";
import { layer as fileSystemLayer } from "@effect/platform-node-shared/NodeFileSystem";
import { layer as pathLayer } from "@effect/platform-node-shared/NodePath";
import { layer as stdioLayer } from "@effect/platform-node-shared/NodeStdio";
import { Effect, Fiber, Layer, Stream } from "effect";
import * as ChildProcess from "effect/process/ChildProcess";
import type { ChildProcessHandle } from "effect/process/ChildProcessSpawner";
import type * as PlatformError from "effect/PlatformError";
import { message, PassesError } from "./errors.ts";

const FORCE_KILL_AFTER = "500 millis";

export const nodeProcessLayer = childProcessLayer.pipe(
  Layer.provideMerge(Layer.mergeAll(fileSystemLayer, pathLayer, stdioLayer)),
);

export type ManagedProcess = ChildProcessHandle;

export const startProcess = Effect.fn("Process.start")(
  (
    command: string,
    args: readonly string[],
    cwd: string,
    input?: string | Stream.Stream<Uint8Array, PlatformError.PlatformError>,
  ) =>
    ChildProcess.make(command, [...args], {
      cwd,
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
      Effect.mapError((error) => new PassesError(`Could not start ${command}: ${message(error)}`)),
    ),
);

export const waitForExit = Effect.fn("Process.waitForExit")((proc: ManagedProcess) =>
  proc.exitCode.pipe(Effect.mapError((error) => new PassesError(message(error)))),
);

function readTail<E, R>(stream: Stream.Stream<Uint8Array, E, R>, limit: number) {
  let contents = "";
  const collect = Stream.decodeText(stream).pipe(
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        contents = (contents + chunk).slice(-limit);
      }),
    ),
    Effect.asVoid,
  );
  return { collect, contents: () => contents };
}

export const collectProcess = Effect.fn("Process.collect")(
  (command: string, args: readonly string[], cwd: string) =>
    Effect.scoped(
      Effect.gen(function* () {
        const proc = yield* startProcess(command, args, cwd);
        const stdout = readTail(proc.stdout, 64_000);
        const stderr = readTail(proc.stderr, 8_000);
        const stdoutFiber = yield* Effect.forkScoped(stdout.collect);
        const stderrFiber = yield* Effect.forkScoped(stderr.collect);
        const code = yield* waitForExit(proc);
        // Descendants can inherit pipes after the leader exits. Bound the drain;
        // scope cleanup then terminates the group through the platform adapter.
        yield* Effect.all([Fiber.join(stdoutFiber), Fiber.join(stderrFiber)]).pipe(
          Effect.timeout("1 second"),
          Effect.mapError(
            (error) =>
              new PassesError(`${command}: ${message(error)} while draining child process output`),
          ),
        );
        return { code, signal: null, stdout: stdout.contents(), stderr: stderr.contents() };
      }),
    ).pipe(
      Effect.timeout("10 seconds"),
      Effect.mapError((error) => new PassesError(`${command}: ${message(error)}`)),
    ),
);

/** Prefix streamed process output while bounding the memory used for a line. */
export function createLineReporter<E, R>(write: (line: string) => Effect.Effect<void, E, R>) {
  let pending = "";
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
