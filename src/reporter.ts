import { closeSync, existsSync, mkdirSync, openSync, realpathSync, writeSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve, sep } from "node:path";
import { message, PassesError } from "./errors.ts";

export interface Reporter {
  readonly out: (line: string) => void;
  readonly err: (line: string) => void;
  readonly detail: (line: string, stream?: "stdout" | "stderr") => void;
}

export const terminal = {
  out: (line: string) => {
    process.stdout.write(`${line}\n`);
  },
  err: (line: string) => {
    process.stderr.write(`${line}\n`);
  },
};

export function createRunReporter(
  repository: string,
  verbose: boolean,
  onFailure: (error: PassesError) => void,
) {
  const stateHome = process.env.XDG_STATE_HOME || join(homedir(), ".local", "state");
  if (!isAbsolute(stateHome)) throw new PassesError("XDG_STATE_HOME must be an absolute path");
  const directory = join(stateHome, "passes", "runs");
  // Resolve existing ancestors so a symlink cannot place logs inside the checkout.
  let ancestor = directory;
  while (!existsSync(ancestor)) ancestor = dirname(ancestor);
  const resolvedDirectory = resolve(realpathSync(ancestor), relative(ancestor, directory));
  const within = relative(realpathSync(repository), resolvedDirectory);
  if (within === "" || (!isAbsolute(within) && within !== ".." && !within.startsWith(`..${sep}`)))
    throw new PassesError("Log directory is inside the checkout; set XDG_STATE_HOME outside it");
  mkdirSync(directory, { recursive: true, mode: 0o700 });
  const path = join(
    directory,
    `${new Date().toISOString().replaceAll(":", "-")}-${crypto.randomUUID()}.log`,
  );
  const fd = openSync(path, "wx", 0o600);
  let failed = false;
  let tail = "";
  function record(line: string): void {
    if (failed) return;
    try {
      const bytes = Buffer.from(`${line}\n`);
      let offset = 0;
      while (offset < bytes.length) offset += writeSync(fd, bytes, offset, bytes.length - offset);
    } catch (error) {
      failed = true;
      onFailure(new PassesError(`Could not write run log ${path}: ${message(error)}`));
    }
  }
  const reporter: Reporter = {
    out: (line) => {
      record(line);
      terminal.out(line);
    },
    err: (line) => {
      record(line);
      terminal.err(line);
    },
    detail: (line, stream = "stdout") => {
      record(line);
      tail = `${tail}${line}\n`.slice(-8_000).split("\n").slice(-21).join("\n");
      if (verbose) (stream === "stderr" ? terminal.err : terminal.out)(line);
    },
  };
  return {
    reporter,
    path,
    context: (line: string) => {
      record(line);
      if (verbose) terminal.out(line);
    },
    finish: (unsuccessful: boolean) => {
      try {
        if (unsuccessful && !verbose && tail) terminal.err(`Recent output:\n${tail.trimEnd()}`);
        terminal.out(`Log: ${path}`);
      } finally {
        closeSync(fd);
      }
    },
  };
}
