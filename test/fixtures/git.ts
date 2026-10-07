import { appendFileSync, readFileSync } from "node:fs";

const eventPath = process.env.PASSES_TEST_EVENTS!;
function log(kind: string) {
  appendFileSync(eventPath, `${JSON.stringify({ kind, pid: process.pid })}\n`);
}

// Keep both processes alive through TERM so scoped cleanup must escalate.
process.on("SIGTERM", () => log("git-term"));
const keepAlive = setInterval(() => {}, 1_000);
if (process.argv[2] === "descendant") {
  log("git-descendant");
} else {
  log("git-spawning");
  Bun.spawn([process.execPath, import.meta.path, "descendant"], {
    stdin: "ignore",
    stdout: "ignore",
    stderr: "ignore",
  });
  while (!readFileSync(eventPath, "utf8").includes('"git-descendant"')) await Bun.sleep(10);
  log("git-started");
  const mode = process.env.PASSES_TEST_GIT_MODE;
  if (mode === "fail") {
    process.stderr.write("fixture Git failure\n");
    clearInterval(keepAlive);
    process.exit(42);
  } else if (mode === "stdout" || mode === "stderr") {
    process[mode].write("x".repeat(1024 * 1024 + 1));
  }
}
