import { BunServices } from "@effect/platform-bun";
import { expect, it, test } from "@effect/vitest";
import { Effect, FileSystem, Path, Stream } from "effect";
import { PassesError } from "../src/errors.ts";
import { captureTextTail, collectProcess, lineReporter } from "../src/process.ts";

it.effect("reusing an output collector starts with an empty buffer", () =>
  Effect.gen(function* () {
    const outputs: string[] = [];
    const collect = captureTextTail(Stream.make(new TextEncoder().encode("hello")), 100, (text) =>
      outputs.push(text),
    );
    yield* collect;
    yield* collect;
    expect(outputs).toEqual(["hello", "hello"]);
  }),
);

it.live("collects complete stdout and stderr without mixing or altering text", () =>
  Effect.gen(function* () {
    const result = yield* collectProcess(
      process.execPath,
      [
        "-e",
        'process.stdout.write("héllo 🌍\\nlast stdout"); process.stderr.write("warning é\\nlast stderr");',
      ],
      process.cwd(),
    );
    expect(result).toEqual({
      code: 0,
      stdout: "héllo 🌍\nlast stdout",
      stderr: "warning é\nlast stderr",
    });
  }).pipe(Effect.provide(BunServices.layer)),
);

it.live("collects separate bounded output tails and preserves nonzero exit codes", () =>
  Effect.gen(function* () {
    const result = yield* collectProcess(
      process.execPath,
      [
        "-e",
        `
      process.stdout.write("discarded stdout prefix\\n" + "x".repeat(70_000) + "\\nlast stdout 🌍");
      process.stderr.write("discarded stderr prefix\\n" + "y".repeat(10_000) + "\\nlast stderr é");
      process.exitCode = 7;
    `,
      ],
      process.cwd(),
    );
    expect(result.code).toBe(7);
    // Assert bounded, intact suffixes without requiring the current buffer capacities.
    expect(result.stdout.length).toBeLessThan(70_000);
    expect(result.stdout).toMatch(/^x+\nlast stdout 🌍$/);
    expect(result.stderr.length).toBeLessThan(10_000);
    expect(result.stderr).toMatch(/^y+\nlast stderr é$/);
  }).pipe(Effect.provide(BunServices.layer)),
);

test("line reporting decodes byte fragments, emits complete lines, and flushes a partial line once", () => {
  // OS pipes may coalesce writes; the exported reporter lets us force byte boundaries deterministically.
  const lines: string[] = [];
  const sink = lineReporter((line) => lines.push(line));
  for (const byte of Buffer.from("héllo 🌍\r\n\npartial")) sink.data(Buffer.from([byte]));
  expect(lines).toEqual(["héllo 🌍", ""]);
  sink.end();
  sink.end();
  expect(lines).toEqual(["héllo 🌍", "", "partial"]);
});

it.live("reports a missing executable as a typed failure", () =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const cwd = yield* fs.makeTempDirectoryScoped({ prefix: "passes-process-test-" });
    const error = yield* Effect.flip(collectProcess(path.join(cwd, "missing-executable"), [], cwd));
    expect(error).toBeInstanceOf(PassesError);
    expect(error.message).toContain("Could not start");
    expect(error.message).toContain("missing-executable");
  }).pipe(Effect.provide(BunServices.layer)),
);
