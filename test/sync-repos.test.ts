import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
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
  const remote = join(ws.root, "remote.git");
  function gitAt(directory: string, ...args: string[]): string {
    const result = Bun.spawnSync([gitExecutable!, ...args], {
      cwd: directory,
      env: ws.env,
    });
    if (result.exitCode !== 0) throw new Error(result.stderr.toString());
    return result.stdout.toString().trim();
  }
  const git = (...args: string[]) => gitAt(destination, ...args);
  const upstream = (...args: string[]) => gitAt(ws.repo, ...args);
  const execPath = gitAt(ws.root, "--exec-path");
  for (const executable of ["git-upload-pack", "git-receive-pack"]) {
    symlinkSync(join(execPath, executable), join(ws.root, "bin", executable));
  }
  upstream("init", "--quiet", "--initial-branch=main");
  upstream("config", "user.name", "Passes test");
  upstream("config", "user.email", "passes@example.invalid");
  const packages = [
    ["packages/effect", "effect"],
    ["packages/platform/bun", "@effect/platform-bun"],
    ["packages/platform/node-shared", "@effect/platform-node-shared"],
  ] as const;
  for (const [directory, name] of packages) {
    mkdirSync(join(ws.repo, directory), { recursive: true });
    writeFileSync(
      join(ws.repo, directory, "package.json"),
      JSON.stringify({ name, version: "4.0.1" }),
    );
  }
  writeFileSync(join(ws.repo, "release.txt"), "original release\n");
  upstream("add", ".");
  upstream("commit", "--quiet", "-m", "Release");
  const release = upstream("rev-parse", "HEAD");
  const tag = "effect@4.0.1";
  if (annotated) upstream("tag", "-a", tag, "-m", "Release tag");
  else upstream("tag", tag);
  gitAt(ws.root, "clone", "--quiet", "--bare", ws.repo, remote);
  mkdirSync(dirname(destination));
  gitAt(ws.root, "clone", "--quiet", remote, destination);
  git("config", "user.name", "Passes test");
  git("config", "user.email", "passes@example.invalid");
  git("remote", "set-url", "origin", "https://github.com/Effect-TS/effect.git");

  const script = join(ws.root, "scripts/sync-repos.ts");
  mkdirSync(dirname(script));
  copyFileSync(join(import.meta.dir, "../scripts/sync-repos.ts"), script);
  writeFileSync(
    join(ws.root, "bun.lock"),
    JSON.stringify({
      packages: Object.fromEntries(packages.map(([, name]) => [name, [`${name}@4.0.1`]])),
    }),
  );
  const wrapper = join(ws.root, "bin/git");
  // Redirect the network boundary to a local bare remote, retaining real fetch
  // and tag replacement. Only the checkout-failure test injects a no-op command.
  writeFileSync(
    wrapper,
    `#!/bin/sh
if [ "$1" = fetch ]; then
  exec ${shellQuote(gitExecutable!)} -c ${shellQuote(`url.${remote}.insteadOf=https://github.com/Effect-TS/effect.git`)} "$@"
fi
if [ "$1" = checkout ] && [ "$PASSES_TEST_SKIP_CHECKOUT" = 1 ]; then exit 0; fi
exec ${shellQuote(gitExecutable!)} "$@"
`,
  );
  chmodSync(wrapper, 0o755);

  async function sync() {
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
    return { code, stdout, stderr };
  }
  return { ws, destination, remote, git, upstream, gitAt, release, tag, sync };
}

describe("repository sync revision checks", () => {
  test.each([false, true])(
    "verifies the release commit with annotated=%s",
    async (annotated) => {
      const { destination, git, release, tag, sync } = syncWorkspace(annotated);
      writeFileSync(join(destination, "release.txt"), "unrelated local history\n");
      git("add", ".");
      git("commit", "--quiet", "-m", "Later commit");
      const result = await sync();
      expect(result.code, result.stderr).toBe(0);
      expect(git("rev-parse", "HEAD")).toBe(release);
      expect(readFileSync(join(destination, "release.txt"), "utf8")).toBe("original release\n");
      expect(result.stdout).toContain(`Ready: repos/effect ${tag} (${release.slice(0, 12)})`);
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
      const { remote, git, gitAt, tag, sync } = syncWorkspace(true);
      git("tag", "-d", tag);
      gitAt(remote, "tag", "-d", tag);
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
      const { ws, destination, remote, git, upstream, release, tag, sync } = syncWorkspace(true);
      const first = await sync();
      expect(first.code, first.stderr).toBe(0);
      writeFileSync(join(ws.repo, "release.txt"), "updated release\n");
      upstream("add", ".");
      upstream("commit", "--quiet", "-m", "New release commit");
      upstream("tag", "-f", "-a", tag, "-m", "Moved release tag");
      const nextRelease = upstream("rev-parse", "HEAD");
      upstream("push", "--force", remote, `refs/tags/${tag}`);
      // Only the remote changed; syncing must discover and check out its new release.
      expect(git("rev-parse", "HEAD")).toBe(release);
      const result = await sync();
      expect(result.code, result.stderr).toBe(0);
      expect(git("rev-parse", "HEAD")).toBe(nextRelease);
      expect(readFileSync(join(destination, "release.txt"), "utf8")).toBe("updated release\n");
      expect(result.stdout).toContain(`(${nextRelease.slice(0, 12)})`);
    },
    timeout,
  );
});
