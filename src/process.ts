import { type ChildProcessWithoutNullStreams, spawn } from "node:child_process";
import { StringDecoder } from "node:string_decoder";
import { Effect } from "effect";
import { message, PassesError } from "./errors.ts";

const GRACE_MS = 500;
export interface ProcessExit {
  readonly code: number | null;
  readonly signal: NodeJS.Signals | null;
}
export interface ManagedProcess {
  readonly child: ChildProcessWithoutNullStreams;
  readonly exit: Promise<ProcessExit>;
  readonly closed: Promise<void>;
}

function signalGroup(child: ChildProcessWithoutNullStreams, signal: NodeJS.Signals): void {
  if (!child.pid) return;
  try {
    // Each child has a dedicated POSIX process group, so ordinary descendants are cancelled too.
    process.kill(-child.pid, signal);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ESRCH") throw error;
  }
}
function groupExists(child: ChildProcessWithoutNullStreams): boolean {
  if (!child.pid) return false;
  try {
    process.kill(-child.pid, 0);
    return true;
  } catch (error) {
    return (error as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export const startProcess = Effect.fn((command: string, args: readonly string[], cwd: string) =>
  Effect.acquireRelease(
    Effect.try({
      try: (): ManagedProcess => {
        const child = spawn(command, [...args], {
          cwd,
          detached: true,
          stdio: ["pipe", "pipe", "pipe"],
          shell: false,
        });
        // Never leave a rejected promise unobserved while setup is still attaching consumers.
        const exit = new Promise<ProcessExit>((resolve, reject) => {
          child.once("error", (error) =>
            reject(new PassesError(`Could not start ${command}: ${message(error)}`)),
          );
          child.once("exit", (code, signal) => resolve({ code, signal }));
        });
        void exit.catch(() => {});
        const closed = new Promise<void>((resolve) => {
          child.once("close", () => resolve());
        });
        // EPIPE during cancellation or early CLI failure must not crash the parent.
        child.stdin.on("error", () => {});
        return { child, exit, closed };
      },
      catch: (error) => new PassesError(`Could not start ${command}: ${message(error)}`),
    }),
    ({ child, exit, closed }) =>
      Effect.gen(function* () {
        child.stdin.destroy();
        yield* Effect.ensuring(
          Effect.gen(function* () {
            if (groupExists(child)) {
              signalGroup(child, "SIGTERM");
              const until = Date.now() + GRACE_MS;
              while (groupExists(child) && Date.now() < until) yield* Effect.sleep(20);
              if (groupExists(child)) signalGroup(child, "SIGKILL");
            }
            yield* Effect.promise(() => Promise.all([exit.catch(() => undefined), closed])).pipe(
              Effect.timeoutOption(1_000),
              Effect.asVoid,
            );
          }),
          Effect.sync(() => {
            child.stdout.destroy();
            child.stderr.destroy();
          }),
        );
      }),
  ),
);

export const waitForExit = Effect.fn((proc: ManagedProcess) =>
  Effect.tryPromise({
    try: () => proc.exit,
    catch: (error) => (error instanceof PassesError ? error : new PassesError(message(error))),
  }),
);

export const collectProcess = Effect.fn((command: string, args: readonly string[], cwd: string) =>
  Effect.scoped(
    Effect.gen(function* () {
      const proc = yield* startProcess(command, args, cwd);
      let stdout = "";
      let stderr = "";
      proc.child.stdout.on("data", (data: Buffer) => {
        stdout = (stdout + data.toString()).slice(-64_000);
      });
      proc.child.stderr.on("data", (data: Buffer) => {
        stderr = (stderr + data.toString()).slice(-8_000);
      });
      proc.child.stdin.end();
      const processExit = yield* waitForExit(proc);
      // exit can precede final pipe data; close marks both streams drained.
      yield* Effect.promise(() => proc.closed);
      return { ...processExit, stdout, stderr };
    }),
  ).pipe(
    Effect.timeout(10_000),
    Effect.mapError((error) => new PassesError(`${command}: ${message(error)}`)),
  ),
);

/** Prefix streaming output without retaining unbounded transcripts or splitting UTF-8. */
export function createLineReporter(write: (line: string) => void) {
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
    data: (chunk: Buffer) => {
      pending += decoder.write(chunk);
      flush(false);
    },
    end: () => {
      pending += decoder.end();
      flush(true);
    },
  };
}
