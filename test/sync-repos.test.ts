import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, copyFileSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { cleanup, timeout, workspace } from "./helpers.ts";

afterEach(cleanup);

const gitExecutable = Bun.which("git");
if (!gitExecutable) throw new Error("Git is required for repository sync tests");

function shellQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`;
}

function syncWorkspace(annotated: boolean) {
  const ws = workspace({ git: false, codex: false });
  const destination = join(ws.root, "repos/effect");
  mkdirSync(destination, { recursive: true });
  function git(...args: string[]): string {
    const result = Bun.spawnSync([gitExecutable!, ...args], {
      cwd: destination,
      env: ws.env,
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  }
  git("init", "--quiet", "--initial-branch=main");
  git("config", "user.name", "Passes test");
  git("config", "user.email", "passes@example.invalid");
  const packages = [
    ["packages/effect", "effect"],
    ["packages/platform/bun", "@effect/platform-bun"],
    ["packages/platform/node-shared", "@effect/platform-node-shared"],
  ] as const;
  for (const [directory, name] of packages) {
    mkdirSync(join(destination, directory), { recursive: true });
    writeFileSync(
      join(destination, directory, "package.json"),
      JSON.stringify({ name, version: "4.0.1" }),
    );
  }
  git("add", ".");
  git("commit", "--quiet", "-m", "Release");
  const release = git("rev-parse", "HEAD");
  const tag = "effect@4.0.1";
  if (annotated) git("tag", "-a", tag, "-m", "Release tag");
  else git("tag", tag);
  git("remote", "add", "origin", "https://github.com/Effect-TS/effect.git");

  const script = join(ws.root, "scripts/sync-repos.ts");
  mkdirSync(dirname(script));
  copyFileSync(join(import.meta.dir, "../scripts/sync-repos.ts"), script);
  writeFileSync(
    join(ws.root, "bun.lock"),
    JSON.stringify({
      packages: Object.fromEntries(packages.map(([, name]) => [name, [`${name}@4.0.1`]])),
    }),
  );
  const callsPath = join(ws.root, "git-calls");
  const wrapper = join(ws.root, "bin/git");
  // Fetch is the only network operation. All revision reads and checkout use real Git.
  writeFileSync(
    wrapper,
    `#!/bin/sh
printf '%s\\n' "$*" >> ${shellQuote(callsPath)}
if [ "$1" = fetch ]; then exit 0; fi
if [ "$1" = checkout ] && [ "$PASSES_TEST_SKIP_CHECKOUT" = 1 ]; then exit 0; fi
exec ${shellQuote(gitExecutable!)} "$@"
`,
  );
  chmodSync(wrapper, 0o755);

  async function sync() {
    writeFileSync(callsPath, "");
    const child = Bun.spawn([process.execPath, script], {
      cwd: ws.root,
      env: ws.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const [code, stdout, stderr] = await Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]);
    const calls = readFileSync(callsPath, "utf8").trim().split("\n");
    return { code, stdout, stderr, calls };
  }
  return { ws, destination, git, release, tag, sync };
}

describe("repository sync revision checks", () => {
  test.each([false, true])(
    "verifies the release commit with annotated=%s",
    async (annotated) => {
      const { git, release, tag, sync } = syncWorkspace(annotated);
      // The tag object differs from the commit for annotated tags.
      expect(git("rev-parse", tag) === release).toBe(!annotated);
      git("commit", "--quiet", "--allow-empty", "-m", "Later commit");
      const result = await sync();
      expect(result.code).toBe(0);
      expect(git("rev-parse", "HEAD")).toBe(release);
      expect(result.stdout).toContain(`Ready: repos/effect ${tag} (${release.slice(0, 12)})`);
      expect(result.calls).toHaveLength(5);
      expect(result.calls.filter((call) => call.startsWith("rev-"))).toEqual([
        `rev-parse ${tag}^{commit} HEAD`,
      ]);
      expect(result.calls.filter((call) => call.startsWith("fetch "))).toHaveLength(1);
    },
    timeout,
  );

  test(
    "rejects a checkout that reports success but leaves HEAD at another commit",
    async () => {
      const { ws, git, tag, sync } = syncWorkspace(true);
      git("commit", "--quiet", "--allow-empty", "-m", "Different commit");
      const head = git("rev-parse", "HEAD");
      ws.env.PASSES_TEST_SKIP_CHECKOUT = "1";
      const result = await sync();
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`repos/effect did not check out ${tag}`);
      expect(result.stdout).not.toContain("Ready:");
      expect(git("rev-parse", "HEAD")).toBe(head);
    },
    timeout,
  );

  test(
    "fails when the release revision cannot be resolved",
    async () => {
      const { ws, git, tag, sync } = syncWorkspace(true);
      git("tag", "-d", tag);
      ws.env.PASSES_TEST_SKIP_CHECKOUT = "1";
      const result = await sync();
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(tag);
      expect(result.stdout).not.toContain("Ready:");
    },
    timeout,
  );

  test(
    "fetches and verifies a moved release tag on each sync",
    async () => {
      const { git, release, tag, sync } = syncWorkspace(true);
      expect((await sync()).code).toBe(0);
      git("commit", "--quiet", "--allow-empty", "-m", "New release commit");
      git("tag", "-f", "-a", tag, "-m", "Moved release tag");
      const nextRelease = git("rev-parse", "HEAD");
      expect(nextRelease).not.toBe(release);
      const result = await sync();
      expect(result.code).toBe(0);
      expect(result.stdout).toContain(`(${nextRelease.slice(0, 12)})`);
      expect(result.calls).toHaveLength(5);
      expect(result.calls.filter((call) => call.startsWith("fetch "))).toHaveLength(1);
    },
    timeout,
  );
});
