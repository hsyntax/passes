import { execFile } from 'node:child_process'
import { existsSync, mkdirSync, readFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { parseAllDocuments } from 'yaml'

type RepositoryPackage = {
  /** The workspace importer whose lockfile entry sets the expected version. */
  readonly importer: string
  readonly packageDirectory: string
  readonly packageName: string
}

type Repository = {
  readonly directory: string
  readonly packages: readonly [RepositoryPackage, ...RepositoryPackage[]]
  readonly repository: string
  readonly tag: (version: string) => string
}

type Lockfile = {
  readonly importers?: Record<
    string,
    Record<string, Record<string, { readonly version?: unknown }> | undefined>
  >
}

const repositories: ReadonlyArray<Repository> = [
  {
    directory: 'effect',
    packages: [
      {
        importer: 'apps/dotpipe-app',
        packageDirectory: 'packages/effect',
        packageName: 'effect',
      },
      {
        importer: 'apps/desktop',
        packageDirectory: 'packages/atom/react',
        packageName: '@effect/atom-react',
      },
    ],
    repository: 'https://github.com/Effect-TS/effect.git',
    tag: (version) => `effect@${version}`,
  },
  {
    directory: 'tanstack-router',
    packages: [
      {
        importer: 'apps/dotpipe-app',
        packageDirectory: 'packages/react-router',
        packageName: '@tanstack/react-router',
      },
    ],
    repository: 'https://github.com/TanStack/router.git',
    tag: (version) => `@tanstack/react-router@${version}`,
  },
  {
    directory: 'tanstack-db',
    packages: [
      {
        importer: 'apps/desktop',
        packageDirectory: 'packages/db',
        packageName: '@tanstack/db',
      },
      {
        importer: 'apps/desktop',
        packageDirectory: 'packages/react-db',
        packageName: '@tanstack/react-db',
      },
    ],
    repository: 'https://github.com/TanStack/db.git',
    tag: (version) => `@tanstack/db@${version}`,
  },
]

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const reposDirectory = resolve(root, 'repos')
const lockfilePath = resolve(root, 'pnpm-lock.yaml')
const execFileAsync = promisify(execFile)

async function runGit(
  directory: string,
  ...args: ReadonlyArray<string>
): Promise<string> {
  const { stdout } = await execFileAsync('git', args, {
    cwd: directory,
    encoding: 'utf8',
  })
  return stdout.trim()
}

function dependencyVersion(
  lockfiles: ReadonlyArray<Lockfile>,
  releasePackage: RepositoryPackage,
): string {
  const dependency = lockfiles
    .flatMap((lockfile) => {
      const importer = lockfile.importers?.[releasePackage.importer]
      return ['dependencies', 'devDependencies', 'optionalDependencies'].map(
        (section) => importer?.[section]?.[releasePackage.packageName],
      )
    })
    .find((candidate) => candidate !== undefined)

  if (typeof dependency?.version !== 'string') {
    throw new Error(
      `Could not find a resolved version for ${releasePackage.packageName} in importer ${releasePackage.importer}`,
    )
  }

  // pnpm appends peer dependency snapshots to registry versions, for example
  // "1.2.3(react@19.0.0)". The upstream source tag uses the package version only.
  const version = dependency.version.split('(', 1)[0]
  if (
    !/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$/.test(version)
  ) {
    throw new Error(
      `Unsupported resolved version for ${releasePackage.packageName}: ${dependency.version}`,
    )
  }

  return version
}

function normalizeRemote(remote: string): string {
  return remote
    .replace(/^git\+/, '')
    .replace(/\/$/, '')
    .replace(/\.git$/, '')
    .toLowerCase()
}

// Packages in one repository can have different versions. The first package
// selects the tag; each package must match its own resolved version.
async function syncRepository(
  repository: Repository,
  versions: ReadonlyArray<string>,
): Promise<void> {
  const destination = resolve(reposDirectory, repository.directory)
  const releasePackage = repository.packages[0]
  const version = versions[0]
  const tag = repository.tag(version)

  if (!existsSync(destination)) {
    console.log(
      `Cloning ${releasePackage.packageName}@${version} into repos/${repository.directory}`,
    )
    await execFileAsync(
      'git',
      [
        'clone',
        '--depth=1',
        '--filter=blob:none',
        '--branch',
        tag,
        repository.repository,
        destination,
      ],
      { cwd: root },
    )
  } else {
    if (!existsSync(resolve(destination, '.git'))) {
      throw new Error(
        `repos/${repository.directory} exists but is not a Git repository`,
      )
    }

    const remote = await runGit(destination, 'remote', 'get-url', 'origin')
    if (normalizeRemote(remote) !== normalizeRemote(repository.repository)) {
      throw new Error(
        `repos/${repository.directory} has unexpected origin ${remote}; expected ${repository.repository}`,
      )
    }

    const status = await runGit(destination, 'status', '--porcelain')
    if (status !== '') {
      throw new Error(
        `repos/${repository.directory} has local changes; preserve or discard them before syncing`,
      )
    }

    await runGit(
      destination,
      'fetch',
      '--depth=1',
      '--force',
      'origin',
      `refs/tags/${tag}:refs/tags/${tag}`,
    )
    await runGit(destination, 'checkout', '--detach', tag)
  }

  for (const [index, repositoryPackage] of repository.packages.entries()) {
    const expectedVersion = versions[index]
    const packageJsonPath = resolve(
      destination,
      repositoryPackage.packageDirectory,
      'package.json',
    )
    if (!existsSync(packageJsonPath)) {
      throw new Error(
        `${repositoryPackage.packageName} package metadata is missing at ${packageJsonPath}`,
      )
    }

    const packageJson = JSON.parse(readFileSync(packageJsonPath, 'utf8')) as {
      readonly name?: unknown
      readonly version?: unknown
    }
    if (
      packageJson.name !== repositoryPackage.packageName ||
      packageJson.version !== expectedVersion
    ) {
      throw new Error(
        `Tag ${tag} contains ${String(packageJson.name)}@${String(packageJson.version)}, expected ${repositoryPackage.packageName}@${expectedVersion}`,
      )
    }
  }

  const expectedCommit = await runGit(destination, 'rev-list', '-n', '1', tag)
  const actualCommit = await runGit(destination, 'rev-parse', 'HEAD')
  if (actualCommit !== expectedCommit) {
    throw new Error(`repos/${repository.directory} did not check out ${tag}`)
  }

  console.log(
    `Ready: repos/${repository.directory} ${tag} (${actualCommit.slice(0, 12)})`,
  )
}

async function main(): Promise<void> {
  // pnpm 12 stores environment and project dependencies in separate YAML documents.
  const lockfiles = parseAllDocuments(readFileSync(lockfilePath, 'utf8')).map(
    (document) => {
      if (document.errors.length > 0) throw document.errors[0]
      return document.toJS() as Lockfile
    },
  )
  mkdirSync(reposDirectory, { recursive: true })

  const targets = repositories.map((repository) => ({
    repository,
    versions: repository.packages.map((repositoryPackage) =>
      dependencyVersion(lockfiles, repositoryPackage),
    ),
  }))
  const results = await Promise.allSettled(
    targets.map(({ repository, versions }) =>
      syncRepository(repository, versions),
    ),
  )
  const failures = results.flatMap((result, index) =>
    result.status === 'rejected'
      ? [
          `${targets[index]?.repository.packages[0].packageName ?? 'unknown repository'}: ${
            result.reason instanceof Error
              ? result.reason.message
              : String(result.reason)
          }`,
        ]
      : [],
  )

  if (failures.length > 0) {
    throw new Error(
      `${failures.length} repository sync(s) failed:\n${failures.join('\n')}`,
    )
  }
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error)
  console.error(`repos:sync failed: ${message}`)
  process.exitCode = 1
})
