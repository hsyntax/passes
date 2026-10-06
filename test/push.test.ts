import { afterEach, describe, expect, test } from "bun:test";
import { chmodSync, readFileSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanup,
  directive,
  events,
  launch,
  stage,
  timeout,
  waitFor,
  workspace,
} from "./helpers.ts";
import type { Workspace } from "./helpers.ts";

afterEach(cleanup);

function git(ws: Workspace, ...args: string[]): string {
  const result = Bun.spawnSync(["git", ...args], { cwd: ws.repo, env: ws.env });
  if (result.exitCode !== 0) throw new Error(result.stderr.toString());
  return result.stdout.toString().trim();
}

function remoteWorkspace({ upstream = false, nested = false } = {}) {
  const ws = workspace({ nested });
  git(ws, "config", "user.name", "Passes test");
  git(ws, "config", "user.email", "passes@example.invalid");
  // Git launches this executable when pushing to a local bare remote.
  symlinkSync(
    join(git(ws, "--exec-path"), "git-receive-pack"),
    join(ws.root, "bin/git-receive-pack"),
  );
  const remote = join(ws.root, "remote.git");
  git(ws, "init", "--bare", "--initial-branch=main", remote);
  git(ws, "remote", "add", "origin", remote);
  git(ws, "commit", "--allow-empty", "-m", "Initial commit");
  if (upstream) git(ws, "push", "-u", "origin", "main");
  return { ws, remote };
}

describe("push after successful stages", () => {
  test(
    "pushes all pending commits after the final stage, including from a nested cwd",
    async () => {
      const { ws, remote } = remoteWorkspace({ nested: true });
      git(ws, "commit", "--allow-empty", "-m", "Existing pending commit");
      const release = join(ws.root, "release-last");
      stage(ws, "first.md", {
        prompt: directive("first", {
          appendFile: { path: "first.txt", content: "first", commit: true },
        }),
      });
      stage(ws, "last.md", {
        step: 1,
        prompt: directive("last", {
          appendFile: { path: "last.txt", content: "last", commit: true },
          releaseFile: release,
        }),
      });
      const marker = join(ws.root, "push-count");
      const hook = join(remote, "hooks/pre-receive");
      writeFileSync(hook, `#!/bin/sh\nprintf 'push\\n' >> '${marker}'\n`);
      chmodSync(hook, 0o755);
      const execution = launch(ws);
      await waitFor(
        () => events(ws).some((event) => event.kind === "ready" && event.id === "last"),
        "final stage waiting for release",
      );
      expect(
        git(ws, "--git-dir", remote, "for-each-ref", "--format=%(refname)", "refs/heads"),
      ).toBe("");
      writeFileSync(release, "release");
      const result = await execution.result;
      expect(result.code).toBe(0);
      expect(git(ws, "--git-dir", remote, "rev-parse", "main")).toBe(git(ws, "rev-parse", "HEAD"));
      expect(git(ws, "--git-dir", remote, "rev-list", "--count", "main")).toBe("4");
      expect(git(ws, "--git-dir", remote, "show", "main:packages/nested app/first.txt")).toBe(
        "first",
      );
      expect(git(ws, "--git-dir", remote, "show", "main:packages/nested app/last.txt")).toBe(
        "last",
      );
      expect(git(ws, "rev-parse", "--abbrev-ref", "@{upstream}")).toBe("origin/main");
      expect(readFileSync(marker, "utf8")).toBe("push\n");
    },
    timeout,
  );

  test(
    "skips pushing with no remote",
    async () => {
      const ws = workspace();
      stage(ws, "stage.md");
      const result = await launch(ws).result;
      expect(result.code).toBe(0);
      expect(result.output).toContain("No Git remote configured; skipping push.");
    },
    timeout,
  );

  test(
    "honors the configured upstream remote and branch",
    async () => {
      const { ws, remote } = remoteWorkspace();
      git(ws, "remote", "rename", "origin", "publish");
      git(ws, "push", "-u", "publish", "HEAD:refs/heads/review");
      git(ws, "config", "push.default", "upstream");
      stage(ws, "stage.md", {
        prompt: directive("edit", {
          appendFile: { path: "edit.txt", content: "edit", commit: true },
        }),
      });
      const result = await launch(ws).result;
      expect(result.code).toBe(0);
      expect(git(ws, "--git-dir", remote, "rev-parse", "review")).toBe(
        git(ws, "rev-parse", "HEAD"),
      );
    },
    timeout,
  );

  test(
    "does not push when a later stage fails",
    async () => {
      const { ws, remote } = remoteWorkspace({ upstream: true });
      const initial = git(ws, "rev-parse", "HEAD");
      stage(ws, "first.md", {
        prompt: directive("edit", {
          appendFile: { path: "edit.txt", content: "edit", commit: true },
        }),
      });
      stage(ws, "failure.md", { step: 1, prompt: directive("failure", { exitCode: 17 }) });
      const result = await launch(ws).result;
      expect(result.code).not.toBe(0);
      expect(git(ws, "rev-parse", "HEAD")).not.toBe(initial);
      expect(git(ws, "--git-dir", remote, "rev-parse", "main")).toBe(initial);
    },
    timeout,
  );

  test(
    "does not push when interrupted",
    async () => {
      const { ws, remote } = remoteWorkspace({ upstream: true });
      const initial = git(ws, "rev-parse", "HEAD");
      stage(ws, "hold.md", {
        prompt: directive("hold", {
          appendFile: { path: "edit.txt", content: "edit", commit: true },
          hold: true,
          stdout: "ready",
        }),
      });
      const execution = launch(ws);
      await waitFor(
        () =>
          git(ws, "rev-parse", "HEAD") !== initial &&
          events(ws).some((event) => event.kind === "start"),
        "stage commit",
      );
      execution.child.kill("SIGTERM");
      expect((await execution.result).code).toBe(143);
      expect(git(ws, "--git-dir", remote, "rev-parse", "main")).toBe(initial);
    },
    timeout,
  );

  test(
    "reports a rejected push and retains local commits",
    async () => {
      const { ws, remote } = remoteWorkspace({ upstream: true });
      const initial = git(ws, "rev-parse", "HEAD");
      const hook = join(remote, "hooks/pre-receive");
      writeFileSync(hook, "#!/bin/sh\nprintf 'Remote rejected update\\n' >&2\nexit 1\n");
      chmodSync(hook, 0o755);
      stage(ws, "stage.md", {
        prompt: directive("edit", {
          appendFile: { path: "edit.txt", content: "edit", commit: true },
        }),
      });
      const result = await launch(ws).result;
      expect(result.code).toBe(1);
      expect(result.output).toContain("Remote rejected update");
      expect(result.output).toContain("git push failed");
      expect(result.output).not.toContain("Finished:");
      expect(git(ws, "rev-parse", "HEAD")).not.toBe(initial);
      expect(git(ws, "--git-dir", remote, "rev-parse", "main")).toBe(initial);
    },
    timeout,
  );

  test(
    "validate never pushes even when there are pending commits",
    async () => {
      const { ws, remote } = remoteWorkspace({ upstream: true });
      const initial = git(ws, "rev-parse", "HEAD");
      git(ws, "commit", "--allow-empty", "-m", "Pending commit");
      stage(ws, "stage.md");
      expect((await launch(ws, ["validate", "stages"]).result).code).toBe(0);
      expect(git(ws, "--git-dir", remote, "rev-parse", "main")).toBe(initial);
      expect(events(ws)).toEqual([]);
    },
    timeout,
  );
});
