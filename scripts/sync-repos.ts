import { BunRuntime, BunServices } from "@effect/platform-bun";
import { Console, Effect, FileSystem, Stream } from "effect";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { message } from "../src/errors.ts";
import { startProcess, waitForExit } from "../src/process.ts";

type RepositoryPackage = {
  readonly packageDirectory: string;
  readonly packageName: string;
};

type Repository = {
  readonly directory: string;
  readonly packages: readonly [RepositoryPackage, ...RepositoryPackage[]];
  readonly repository: string;
  readonly tag: (version: string) => string;
};

type Lockfile = {
  readonly packages?: Record<string, readonly unknown[]>;
};

const repositories: ReadonlyArray<Repository> = [
  {
    directory: "effect",
    packages: [
      {
        packageDirectory: "packages/effect",
        packageName: "effect",
      },
      {
        packageDirectory: "packages/platform/bun",
        packageName: "@effect/platform-bun",
      },
      {
        packageDirectory: "packages/platform/node-shared",
        packageName: "@effect/platform-node-shared",
      },
    ],
    repository: "https://github.com/Effect-TS/effect.git",
    tag: (version) => `effect@${version}`,
  },
];

const projectDirectory = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reposDirectory = resolve(projectDirectory, "repos");
const lockfilePath = resolve(projectDirectory, "bun.lock");
// Match execFile's per-stream buffer bound without truncating successful Git output.
const MAX_OUTPUT_BYTES = 1024 * 1024;
const collectGitOutput = <E, R>(stream: Stream.Stream<Uint8Array, E, R>, channel: string) =>
  stream.pipe(
    Stream.runFoldEffect(
      () => ({ bytes: 0, chunks: [] as Uint8Array[] }),
      (output, chunk) => {
        output.bytes += chunk.byteLength;
        if (output.bytes > MAX_OUTPUT_BYTES)
          return Effect.fail(new Error(`${channel} maxBuffer length exceeded`));
        output.chunks.push(chunk);
        return Effect.succeed(output);
      },
    ),
    Effect.map(({ chunks }) => Buffer.concat(chunks).toString("utf8")),
  );

const runGit = Effect.fn("Repos.runGit")((directory: string, ...args: ReadonlyArray<string>) =>
  Effect.scoped(
    Effect.gen(function* () {
      // Reuse the adopted spawner: interruption releases the process group and
      // escalates to SIGKILL. A fetch/clone has no arbitrary command deadline.
      const proc = yield* startProcess("git", args, directory);
      const [code, stdout, stderr] = yield* Effect.all(
        [
          waitForExit(proc),
          collectGitOutput(proc.stdout, "stdout"),
          collectGitOutput(proc.stderr, "stderr"),
        ],
        { concurrency: "unbounded" },
      );
      if (code !== 0)
        return yield* Effect.fail(
          new Error(`Command failed: git ${args.join(" ")}\n${stderr}`, {
            cause: { code, stdout, stderr, command: ["git", ...args] },
          }),
        );
      return stdout.trim();
    }),
  ),
);

const readResolvedDependencyVersion = Effect.fn(function* (
  lockfile: Lockfile,
  repositoryPackage: RepositoryPackage,
) {
  const resolution = lockfile?.packages?.[repositoryPackage.packageName]?.[0];
  if (typeof resolution !== "string") {
    return yield* Effect.fail(
      new Error(
        `Could not find a resolved version for ${repositoryPackage.packageName} in bun.lock`,
      ),
    );
  }

  // Bun stores registry resolutions as "name@version", including scoped names.
  const prefix = `${repositoryPackage.packageName}@`;
  const version = resolution.slice(prefix.length);
  if (
    !resolution.startsWith(prefix) ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
  ) {
    return yield* Effect.fail(
      new Error(`Unsupported resolved version for ${repositoryPackage.packageName}: ${resolution}`),
    );
  }

  return version;
});

function normalizeRemote(remote: string): string {
  return remote
    .replace(/^git\+/, "")
    .replace(/\/$/, "")
    .replace(/\.git$/, "")
    .toLowerCase();
}

// Packages in one repository can have different versions. The first package
// selects the tag; each package must match its own resolved version.
const syncRepository = Effect.fn("Repos.syncRepository")(function* (
  repository: Repository,
  resolvedPackageVersions: ReadonlyArray<string>,
) {
  const fs = yield* FileSystem.FileSystem;
  const destination = resolve(reposDirectory, repository.directory);
  const releasePackage = repository.packages[0];
  const version = resolvedPackageVersions[0];
  if (version === undefined)
    return yield* Effect.fail(new Error(`Missing version for ${releasePackage.packageName}`));
  const tag = repository.tag(version);

  if (!(yield* fs.exists(destination))) {
    yield* Console.log(
      `Cloning ${releasePackage.packageName}@${version} into repos/${repository.directory}`,
    );
    yield* runGit(
      projectDirectory,
      "clone",
      "--depth=1",
      "--filter=blob:none",
      "--branch",
      tag,
      repository.repository,
      destination,
    );
  } else {
    if (!(yield* fs.exists(resolve(destination, ".git")))) {
      return yield* Effect.fail(
        new Error(`repos/${repository.directory} exists but is not a Git repository`),
      );
    }

    const remote = yield* runGit(destination, "remote", "get-url", "origin");
    if (normalizeRemote(remote) !== normalizeRemote(repository.repository)) {
      return yield* Effect.fail(
        new Error(
          `repos/${repository.directory} has unexpected origin ${remote}; expected ${repository.repository}`,
        ),
      );
    }

    const status = yield* runGit(destination, "status", "--porcelain");
    if (status !== "") {
      return yield* Effect.fail(
        new Error(
          `repos/${repository.directory} has local changes; preserve or discard them before syncing`,
        ),
      );
    }

    yield* runGit(
      destination,
      "fetch",
      "--depth=1",
      "--force",
      "origin",
      `refs/tags/${tag}:refs/tags/${tag}`,
    );
    yield* runGit(destination, "checkout", "--detach", tag);
  }

  for (const [index, repositoryPackage] of repository.packages.entries()) {
    const expectedVersion = resolvedPackageVersions[index];
    const packageJsonPath = resolve(
      destination,
      repositoryPackage.packageDirectory,
      "package.json",
    );
    const source = yield* fs.readFile(packageJsonPath).pipe(
      Effect.catchReason("PlatformError", "NotFound", () =>
        Effect.fail(
          new Error(
            `${repositoryPackage.packageName} package metadata is missing at ${packageJsonPath}`,
          ),
        ),
      ),
      Effect.map((bytes) => Buffer.from(bytes).toString("utf8")),
    );
    const packageJson = yield* Effect.try({
      try: () =>
        JSON.parse(source) as { readonly name?: unknown; readonly version?: unknown } | null,
      catch: (error) => error,
    });
    if (
      packageJson?.name !== repositoryPackage.packageName ||
      packageJson?.version !== expectedVersion
    ) {
      return yield* Effect.fail(
        new Error(
          `Tag ${tag} contains ${String(packageJson?.name)}@${String(packageJson?.version)}, expected ${repositoryPackage.packageName}@${expectedVersion}`,
        ),
      );
    }
  }

  // Resolve this fixed pair in argument order, peeling annotated tags to their commit.
  const commits = yield* runGit(destination, "rev-parse", `${tag}^{commit}`, "HEAD").pipe(
    Effect.map((output) => output.split("\n")),
  );
  const [releaseCommit, checkoutCommit] = commits;
  if (commits.length !== 2 || !checkoutCommit || checkoutCommit !== releaseCommit) {
    return yield* Effect.fail(new Error(`repos/${repository.directory} did not check out ${tag}`));
  }

  yield* Console.log(
    `Ready: repos/${repository.directory} ${tag} (${checkoutCommit.slice(0, 12)})`,
  );
});

const main = Effect.gen(function* () {
  const fs = yield* FileSystem.FileSystem;
  const source = yield* fs
    .readFile(lockfilePath)
    .pipe(Effect.map((bytes) => Buffer.from(bytes).toString("utf8")));
  const lockfile = yield* Effect.try({
    try: () => Bun.JSONC.parse(source) as Lockfile,
    catch: (error) => error,
  });
  const targets = yield* Effect.forEach(repositories, (repository) =>
    Effect.forEach(repository.packages, (repositoryPackage) =>
      readResolvedDependencyVersion(lockfile, repositoryPackage),
    ).pipe(Effect.map((resolvedPackageVersions) => ({ repository, resolvedPackageVersions }))),
  );
  yield* fs.makeDirectory(reposDirectory, { recursive: true });
  const [, failures] = yield* Effect.partition(
    targets,
    ({ repository, resolvedPackageVersions }) =>
      Effect.mapError(syncRepository(repository, resolvedPackageVersions), (error) => ({
        error,
        diagnostic: `${repository.packages[0].packageName}: ${message(error)}`,
      })),
    { concurrency: "unbounded" },
  );
  if (failures.length > 0)
    return yield* Effect.fail(
      new Error(
        `${failures.length} repository sync(s) failed:\n${failures.map((failure) => failure.diagnostic).join("\n")}`,
        { cause: failures.map((failure) => failure.error) },
      ),
    );
});

BunRuntime.runMain(
  main.pipe(
    Effect.tapError((error) => Console.error(`repos:sync failed: ${message(error)}`)),
    Effect.provide(BunServices.layer),
  ),
  { disableErrorReporting: true },
);
