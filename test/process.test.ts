import { BunServices } from "@effect/platform-bun";
import { expect, it } from "@effect/vitest";
import { Effect } from "effect";
import { collectProcess } from "../src/process.ts";

it.live("collects separate bounded output tails and preserves nonzero exit codes", () =>
  Effect.gen(function* () {
    const result = yield* collectProcess(
      process.execPath,
      [
        "-e",
        `
      process.stdout.write("x".repeat(70_000) + "🌍");
      process.stderr.write("y".repeat(10_000) + "é");
      process.exitCode = 7;
    `,
      ],
      process.cwd(),
    );
    expect(result.code).toBe(7);
    expect(result.stdout).toHaveLength(64_000);
    expect(result.stdout.endsWith("🌍")).toBe(true);
    expect(result.stderr).toHaveLength(8_000);
    expect(result.stderr.endsWith("é")).toBe(true);
  }).pipe(Effect.provide(BunServices.layer)),
);

it.live("reports a missing executable as a typed failure", () =>
  Effect.gen(function* () {
    const error = yield* Effect.flip(
      collectProcess("/passes-test/missing-executable", [], process.cwd()),
    );
    expect(error.message).toContain("Could not start");
    expect(error.message).toContain("missing-executable");
  }).pipe(Effect.provide(BunServices.layer)),
);
