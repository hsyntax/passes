import { StringDecoder } from "node:string_decoder";
import { Effect, Fiber, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { message, PassesError } from "./errors.ts";

const termination = { killSignal: "SIGTERM", forceKillAfter: "500 millis" } as const;

export const startProcess = Effect.fnUntraced(
  function* (command: string, args: readonly string[], cwd: string) {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const proc = yield* spawner.spawn(
      ChildProcess.make(command, args, {
        cwd,
        detached: true,
        shell: false,
        ...termination,
      }),
    );
    // Explicit kill waits for and escalates surviving process-group members even
    // after a nonzero leader exit, and lets callers stop before draining output.
    const stop = yield* Effect.cached(Effect.ignore(proc.kill(termination)));
    yield* Effect.addFinalizer(() => stop);
    return { ...proc, stop };
  },
  (effect, command) =>
    effect.pipe(
      Effect.mapError(
        (cause) =>
          new PassesError({ message: `Could not start ${command}: ${message(cause)}`, cause }),
      ),
    ),
);

export const collectProcess = Effect.fnUntraced(
  function* (command: string, args: readonly string[], cwd: string) {
    const proc = yield* startProcess(command, args, cwd);
    let stdout = "";
    let stderr = "";
    const out = yield* captureTextTail(proc.stdout, 64_000, (text) => (stdout = text)).pipe(
      Effect.forkScoped,
    );
    const err = yield* captureTextTail(proc.stderr, 8_000, (text) => (stderr = text)).pipe(
      Effect.forkScoped,
    );
    yield* Stream.run(Stream.empty, proc.stdin);
    const code = yield* proc.exitCode;
    yield* Effect.all([Fiber.join(out), Fiber.join(err)], { concurrency: "unbounded" });
    return { code, stdout, stderr };
  },
  Effect.scoped,
  (effect, command) =>
    effect.pipe(
      Effect.timeout(10_000),
      Effect.mapError(
        (cause) => new PassesError({ message: `${command}: ${message(cause)}`, cause }),
      ),
    ),
);

/** Drain a byte stream while retaining only its most recent decoded text. */
export const captureTextTail = Effect.fnUntraced(function* <E, R>(
  stream: Stream.Stream<Uint8Array, E, R>,
  limit: number,
  update: (text: string) => void,
) {
  let text = "";
  yield* stream.pipe(
    Stream.decodeText(),
    Stream.runForEach((chunk) =>
      Effect.sync(() => {
        text = (text + chunk).slice(-limit);
        update(text);
      }),
    ),
  );
});

/** Prefix streaming output without retaining unbounded transcripts or splitting UTF-8. */
export function lineReporter(write: (line: string) => void) {
  const decoder = new StringDecoder("utf8");
  let pending = "";
  function flush(full: boolean): void {
    let newline = pending.indexOf("\n");
    while (newline >= 0) {
      write(pending.slice(0, newline).replace(/\r$/, ""));
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
    }
    // A tool can emit arbitrarily long lines. Keep the memory bound predictable.
    while (pending.length > 8_192) {
      write(pending.slice(0, 8_192));
      pending = pending.slice(8_192);
    }
    if (full && pending) {
      write(pending);
      pending = "";
    }
  }
  return {
    data: (chunk: Uint8Array) => {
      pending += decoder.write(chunk);
      flush(false);
    },
    end: () => {
      pending += decoder.end();
      flush(true);
    },
  };
}
