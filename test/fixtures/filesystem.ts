import { mock } from "bun:test";
import * as fs from "node:fs";
import { relative, sep } from "node:path";

// Observe native calls in the sync subprocess, forwarding the original API
// unchanged. Restrict recording to manifests in its temporary release checkout.
const directory = process.env.PASSES_TEST_MANIFEST_DIRECTORY!;
const eventPath = process.env.PASSES_TEST_FILESYSTEM_EVENTS!;
function observe(operation: "access" | "readFile") {
  return {
    apply(target: typeof fs.access | typeof fs.readFile, thisArgument: unknown, args: unknown[]) {
      const path = args[0];
      if (
        typeof path === "string" &&
        path.startsWith(`${directory}${sep}`) &&
        path.endsWith(`${sep}package.json`)
      ) {
        fs.appendFileSync(
          eventPath,
          `${JSON.stringify({ operation, path: relative(directory, path) })}\n`,
        );
      }
      return Reflect.apply(target, thisArgument, args);
    },
  };
}

mock.module("node:fs", () => ({
  ...fs,
  access: new Proxy(fs.access, observe("access")),
  readFile: new Proxy(fs.readFile, observe("readFile")),
}));
