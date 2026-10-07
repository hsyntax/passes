import { afterEach, describe, expect, test } from "bun:test";
import {
  chmodSync,
  copyFileSync,
  mkdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { dirname, join } from "node:path";
import { cleanup, events, expectFixtureStopped, timeout, waitFor, workspace } from "./helpers.ts";

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
  // The copied entrypoint resolves the same application modules and installed services.
  symlinkSync(join(import.meta.dir, "../src"), join(ws.root, "src"));
  symlinkSync(join(import.meta.dir, "../node_modules"), join(ws.root, "node_modules"));
  writeFileSync(
    join(ws.root, "bun.lock"),
    JSON.stringify({
      packages: Object.fromEntries(packages.map(([, name]) => [name, [`${name}@4.0.1`]])),
    }),
  );
  const wrapper = join(ws.root, "bin/git");
  // Keep clone/fetch local with real Git. Cleanup and failure cases substitute
  // a process fixture; checkout-mismatch cases inject a successful no-op.
  writeFileSync(
    wrapper,
    `#!/bin/sh
if [ "$1" = fetch ] && [ -n "$PASSES_TEST_GIT_MODE" ]; then
  exec ${shellQuote(process.execPath)} ${shellQuote(join(import.meta.dir, "fixtures/git.ts"))}
fi
if [ "$1" = fetch ] || [ "$1" = clone ]; then
  exec ${shellQuote(gitExecutable!)} -c ${shellQuote(`url.${remote}.insteadOf=https://github.com/Effect-TS/effect.git`)} "$@"
fi
if [ "$1" = checkout ] && [ "$PASSES_TEST_SKIP_CHECKOUT" = 1 ]; then exit 0; fi
exec ${shellQuote(gitExecutable!)} "$@"
`,
  );
  chmodSync(wrapper, 0o755);

  function launch() {
    const child = Bun.spawn([process.execPath, script], {
      cwd: ws.root,
      env: ws.env,
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    });
    const result = Promise.all([
      child.exited,
      new Response(child.stdout).text(),
      new Response(child.stderr).text(),
    ]).then(([code, stdout, stderr]) => ({ code, stdout, stderr }));
    return { child, result };
  }
  const sync = () => launch().result;
  return { ws, destination, remote, git, upstream, gitAt, release, tag, sync, launch };
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

describe("repository sync Effect boundaries", () => {
  test(
    "clones and verifies a missing checkout",
    async () => {
      const { destination, git, release, tag, sync } = syncWorkspace(true);
      rmSync(destination, { recursive: true });
      const result = await sync();
      expect(result.code, result.stderr).toBe(0);
      expect(result.stdout).toContain("Cloning effect@4.0.1");
      expect(result.stdout).toContain(`Ready: repos/effect ${tag}`);
      expect(git("rev-parse", "HEAD")).toBe(release);
    },
    timeout,
  );

  test(
    "rejects dirty checkouts before fetching",
    async () => {
      const { destination, sync } = syncWorkspace(false);
      writeFileSync(join(destination, "release.txt"), "local edit\n");
      const result = await sync();
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("has local changes");
      expect(readFileSync(join(destination, "release.txt"), "utf8")).toBe("local edit\n");
    },
    timeout,
  );

  test(
    "rejects malformed manifests as a repository failure",
    async () => {
      const { ws, destination, git, sync } = syncWorkspace(false);
      writeFileSync(join(destination, "packages/effect/package.json"), "null");
      git("add", ".");
      git("commit", "--quiet", "-m", "Invalid manifest");
      // Keep this checkout for the manifest check, as in the revision-mismatch case.
      ws.env.PASSES_TEST_SKIP_CHECKOUT = "1";
      const result = await sync();
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("Tag effect@4.0.1 contains undefined@undefined");
      expect(result.stdout).not.toContain("Ready:");
    },
    timeout,
  );

  test.each(["SIGINT", "SIGTERM"] as const)(
    "%s interrupts Git and cleans up its group",
    async (signal) => {
      const { ws, launch } = syncWorkspace(false);
      ws.env.PASSES_TEST_GIT_MODE = "hold";
      const running = launch();
      try {
        await waitFor(
          () => events(ws).some((event) => event.kind === "git-started"),
          "Git fixture to start",
        );
        running.child.kill(signal);
        const result = await running.result;
        expect(result.code).toBe(130);
        expect(result.stdout).not.toContain("Ready:");
        expect(result.stderr).not.toContain("repository sync(s) failed");
        await expectFixtureStopped(ws);
      } finally {
        if (running.child.exitCode === null) running.child.kill("SIGKILL");
        await running.result;
      }
    },
    timeout,
  );

  test(
    "retains Git failure diagnostics and releases descendants",
    async () => {
      const { ws, sync } = syncWorkspace(false);
      ws.env.PASSES_TEST_GIT_MODE = "fail";
      const result = await sync();
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("1 repository sync(s) failed:");
      expect(result.stderr).toContain("Command failed: git fetch");
      expect(result.stderr).toContain("fixture Git failure");
      expect(result.stdout).not.toContain("Ready:");
      await expectFixtureStopped(ws);
    },
    timeout,
  );

  test.each(["stdout", "stderr"])(
    "bounds %s and releases descendants on overflow",
    async (channel) => {
      const { ws, sync } = syncWorkspace(false);
      ws.env.PASSES_TEST_GIT_MODE = channel;
      const result = await sync();
      expect(result.code).toBe(1);
      expect(result.stderr).toContain(`${channel} maxBuffer length exceeded`);
      expect(result.stdout).not.toContain("Ready:");
      await expectFixtureStopped(ws);
    },
    timeout,
  );
});
