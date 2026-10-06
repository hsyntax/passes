import { execFile } from "node:child_process";
import { existsSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

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

const root = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const reposDirectory = resolve(root, "repos");
const lockfilePath = resolve(root, "bun.lock");
const execFileAsync = promisify(execFile);

async function runGit(directory: string, ...args: ReadonlyArray<string>): Promise<string> {
  const { stdout } = await execFileAsync("git", args, {
    cwd: directory,
    encoding: "utf8",
  });
  return stdout.trim();
}

function dependencyVersion(lockfile: Lockfile, releasePackage: RepositoryPackage): string {
  const resolution = lockfile.packages?.[releasePackage.packageName]?.[0];
  if (typeof resolution !== "string") {
    throw new Error(
      `Could not find a resolved version for ${releasePackage.packageName} in bun.lock`,
    );
  }

  // Bun stores registry resolutions as "name@version", including scoped names.
  const prefix = `${releasePackage.packageName}@`;
  const version = resolution.slice(prefix.length);
  if (
    !resolution.startsWith(prefix) ||
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
  ) {
    throw new Error(
      `Unsupported resolved version for ${releasePackage.packageName}: ${resolution}`,
    );
  }

  return version;
}

function normalizeRemote(remote: string): string {
  return remote
    .replace(/^git\+/, "")
    .replace(/\/$/, "")
    .replace(/\.git$/, "")
    .toLowerCase();
}

// Packages in one repository can have different versions. The first package
// selects the tag; each package must match its own resolved version.
async function syncRepository(
  repository: Repository,
  versions: ReadonlyArray<string>,
): Promise<void> {
  const destination = resolve(reposDirectory, repository.directory);
  const releasePackage = repository.packages[0];
  const version = versions[0];
  if (version === undefined) throw new Error(`Missing version for ${releasePackage.packageName}`);
  const tag = repository.tag(version);

  if (!existsSync(destination)) {
    console.log(
      `Cloning ${releasePackage.packageName}@${version} into repos/${repository.directory}`,
    );
    await execFileAsync(
      "git",
      [
        "clone",
        "--depth=1",
        "--filter=blob:none",
        "--branch",
        tag,
        repository.repository,
        destination,
      ],
      { cwd: root },
    );
  } else {
    if (!existsSync(resolve(destination, ".git"))) {
      throw new Error(`repos/${repository.directory} exists but is not a Git repository`);
    }

    const remote = await runGit(destination, "remote", "get-url", "origin");
    if (normalizeRemote(remote) !== normalizeRemote(repository.repository)) {
      throw new Error(
        `repos/${repository.directory} has unexpected origin ${remote}; expected ${repository.repository}`,
      );
    }

    const status = await runGit(destination, "status", "--porcelain");
    if (status !== "") {
      throw new Error(
        `repos/${repository.directory} has local changes; preserve or discard them before syncing`,
      );
    }

    await runGit(
      destination,
      "fetch",
      "--depth=1",
      "--force",
      "origin",
      `refs/tags/${tag}:refs/tags/${tag}`,
    );
    await runGit(destination, "checkout", "--detach", tag);
  }

  for (const [index, repositoryPackage] of repository.packages.entries()) {
    const expectedVersion = versions[index];
    const packageJsonPath = resolve(
      destination,
      repositoryPackage.packageDirectory,
      "package.json",
    );
    if (!existsSync(packageJsonPath)) {
      throw new Error(
        `${repositoryPackage.packageName} package metadata is missing at ${packageJsonPath}`,
      );
    }

    const packageJson = JSON.parse(readFileSync(packageJsonPath, "utf8")) as {
      readonly name?: unknown;
      readonly version?: unknown;
    };
    if (
      packageJson.name !== repositoryPackage.packageName ||
      packageJson.version !== expectedVersion
    ) {
      throw new Error(
        `Tag ${tag} contains ${String(packageJson.name)}@${String(packageJson.version)}, expected ${repositoryPackage.packageName}@${expectedVersion}`,
      );
    }
  }

  // Resolve this fixed pair in argument order, peeling annotated tags to their commit.
  const commits = (await runGit(destination, "rev-parse", `${tag}^{commit}`, "HEAD")).split("\n");
  const [expectedCommit, actualCommit] = commits;
  if (commits.length !== 2 || !actualCommit || actualCommit !== expectedCommit) {
    throw new Error(`repos/${repository.directory} did not check out ${tag}`);
  }

  console.log(`Ready: repos/${repository.directory} ${tag} (${actualCommit.slice(0, 12)})`);
}

async function main(): Promise<void> {
  const lockfile = Bun.JSONC.parse(readFileSync(lockfilePath, "utf8")) as Lockfile;
  const targets = repositories.map((repository) => ({
    repository,
    versions: repository.packages.map((repositoryPackage) =>
      dependencyVersion(lockfile, repositoryPackage),
    ),
  }));
  mkdirSync(reposDirectory, { recursive: true });
  const results = await Promise.allSettled(
    targets.map(({ repository, versions }) => syncRepository(repository, versions)),
  );
  const failures = results.flatMap((result, index) =>
    result.status === "rejected"
      ? [
          `${targets[index]?.repository.packages[0].packageName ?? "unknown repository"}: ${
            result.reason instanceof Error ? result.reason.message : String(result.reason)
          }`,
        ]
      : [],
  );

  if (failures.length > 0) {
    throw new Error(`${failures.length} repository sync(s) failed:\n${failures.join("\n")}`);
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  console.error(`repos:sync failed: ${message}`);
  process.exitCode = 1;
});
