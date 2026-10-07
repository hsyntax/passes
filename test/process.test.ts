import { BunServices } from "@effect/platform-bun";
import { expect, test } from "bun:test";
import { Effect } from "effect";
import { ExitCode } from "effect/process/ChildProcessSpawner";
import { runCommand } from "../src/process.ts";

test("commands drain both output streams and retain bounded Unicode tails on nonzero exit", async () => {
  const stdout = `${"out🌍".repeat(30_000)}\nstdout end\n`;
  const stderr = `${"err🌍".repeat(10_000)}\nstderr end\n`;
  const result = await runCommand(
    process.execPath,
    [
      "-e",
      `await Promise.all([
        Bun.write(Bun.stdout, "out🌍".repeat(30_000) + "\\nstdout end\\n"),
        Bun.write(Bun.stderr, "err🌍".repeat(10_000) + "\\nstderr end\\n")
      ]);
      process.exit(7);`,
    ],
    process.cwd(),
  ).pipe(Effect.provide(BunServices.layer), Effect.runPromise);

  expect(result.code).toBe(ExitCode(7));
  expect(result.stdout).toBe(stdout.slice(-64_000));
  expect(result.stderr).toBe(stderr.slice(-8_000));
});
