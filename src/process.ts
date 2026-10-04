import { StringDecoder } from "node:string_decoder";
import { Effect, Fiber, Stream } from "effect";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import { message, PassesError } from "./errors.ts";

const termination = { killSignal: "SIGTERM", forceKillAfter: "500 millis" } as const;

export function startProcess(command: string, args: readonly string[], cwd: string) {
  return Effect.gen(function* () {
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const proc = yield* spawner.spawn(
      ChildProcess.make(command, args, {
        cwd,
        detached: true,
        shell: false,
        ...termination,
      }),
    );
    // Effect 4.0.0's release path only sends TERM if the leader exited nonzero.
    // Explicit kill also waits for and escalates surviving process-group members.
    const stop = yield* Effect.cached(Effect.ignore(proc.kill(termination)));
    yield* Effect.addFinalizer(() => stop);
    return { ...proc, stop };
  }).pipe(
    Effect.mapError((error) => new PassesError(`Could not start ${command}: ${message(error)}`)),
  );
}

export function collectProcess(command: string, args: readonly string[], cwd: string) {
  return Effect.scoped(
    Effect.gen(function* () {
      const proc = yield* startProcess(command, args, cwd);
      let stdout = "";
      let stderr = "";
      const out = yield* proc.stdout.pipe(
        Stream.decodeText(),
        Stream.runForEach((data) =>
          Effect.sync(() => {
            stdout = (stdout + data).slice(-64_000);
          }),
        ),
        Effect.forkScoped,
      );
      const err = yield* proc.stderr.pipe(
        Stream.decodeText(),
        Stream.runForEach((data) =>
          Effect.sync(() => {
            stderr = (stderr + data).slice(-8_000);
          }),
        ),
        Effect.forkScoped,
      );
      yield* Stream.run(Stream.empty, proc.stdin);
      const code = yield* proc.exitCode;
      yield* Effect.all([Fiber.join(out), Fiber.join(err)], { concurrency: "unbounded" });
      return { code, stdout, stderr };
    }),
  ).pipe(
    Effect.timeout(10_000),
    Effect.mapError((error) => new PassesError(`${command}: ${message(error)}`)),
  );
}

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
