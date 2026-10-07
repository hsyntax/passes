# passes

A small TypeScript + Effect + Bun runner for Markdown-defined Codex stages.
Stages with the same `step` run concurrently, with at most four Codex processes
active at once in the existing checkout. Layers run in ascending numeric order,
with a full barrier between layers.

## Quick start

Requirements: Bun 1.4.2+, Git, and Codex CLI 0.159.2+ on macOS or Linux. Configure
Codex authentication separately before a real run. No model calls or login setup
are needed to install, validate, build, or test this package.

```sh
# In this package directory
bun install --frozen-lockfile
bun run check
bun src/cli.ts validate ./examples/stages
```

From the repository and exact directory where the agents should work:

```sh
bun /absolute/path/to/passes/src/cli.ts validate ./stages
bun /absolute/path/to/passes/src/cli.ts run ./stages
```

The stage directory is resolved relative to your invocation directory, not the
runner's source directory. Agents retain that invocation directory even if it is
a subdirectory of the checkout. `run` requires an existing Git working tree;
`validate` also works outside Git and never invokes Git or Codex.

Use `passes run ./stages --scope pr --fast` to request fast mode for every model
that advertises support in Codex's catalog. Reasoning effort stays unchanged.
The runner prints each model's selection and uses Codex's configured defaults
when fast support is not advertised. Without `--fast`, service-tier configuration
is left to Codex. Fast mode uses more quota; availability depends on the model and
account. See [Codex speed settings](https://learn.chatgpt.com/docs/agent-configuration/speed).

`run` saves a separate log for each execution and prints concise stage progress,
the latest commit, and push status. The log path appears at the start and end.
Use `passes run ./stages --verbose` to also stream all stage output to the terminal.
Logs include the execution plan, labeled stage stdout/stderr, Git push output,
and runner diagnostics. They are written as output arrives; partial lines are
flushed when stages finish or are cancelled. On failure or interruption, the
default terminal view shows up to 20 recent output lines (at most 8,000 characters).

Logs live in `~/.local/state/passes/runs/`, or `$XDG_STATE_HOME/passes/runs/` when
that absolute path is configured. Each file has a timestamp and unique ID and is
created with owner-only permissions. Log destinations inside the target checkout,
including through symlinks, are rejected so stages cannot accidentally commit
logs. Logs are retained until you delete them. If a log cannot be created, stages
do not start; a write failure cancels the run. `validate`, `--help`, and `--version`
do not create logs.

For the short `passes` command, run `bun link` in this package and ensure Bun's
bin directory is on `PATH`. Alternatively, `bun run build` creates a bundled Bun
entry point at `dist/passes.js`; run it with `bun /path/to/dist/passes.js ...`.

This is a standalone project and does not import application code. Keep it in its
own directory and invoke it from whichever Git checkout should receive edits.

For a local installation at `~/projects/passes`:

```sh
cd ~/projects/passes
bun install --frozen-lockfile
bun run check
bun link

# In the Git checkout where agents should work:
passes validate ./stages
passes run ./stages
```

Adapt the example stages to your files before running them.

## Repository stages

The included `stages` directory runs eight sequential passes:

1. Step 0: Clean up tests (`gpt-6.1-sol`, `high`)
2. Step 1: Adopt Effect ecosystem packages (`gpt-6.1-sol`, `high`), replacing custom implementation with suitable packages and services across the ecosystem
3. Step 2: Isolate non-Effect boundaries (`gpt-6-luna`, `xhigh`)
4. Step 3: Apply Effect modules (`gpt-6-luna`, `xhigh`), including composition and behavior preservation
5. Step 4: Reduce redundant I/O (`gpt-6.1-sol`, `xhigh`), removing unnecessary external operations and verifying improvements with counts or measurements
6. Step 5: Remove dead code (`gpt-6.1-sol`, `high`), verifying unused or redundant paths before deleting them
7. Step 6: Align domain names (`gpt-6-luna`, `xhigh`), using established vocabulary within each bounded context
8. Step 7: Choose Effect function constructors (`gpt-6-luna`, `xhigh`), preserving intentional observability

Package adoption runs before boundary adapters and local composition rewrites. It
starts with the full vendored `repos/effect` package tree and looks beyond platform
services for integrations that simplify the complete implementation and reduce
maintained code. Fast mode is a runner-wide `--fast` flag, not a stage field.

## Stage format

```markdown
---
name: Simplify error handling
step: 0
model: gpt-6-luna
reasoning_effort: medium
---

Review src/example/errors.ts. Simplify redundant Effect composition while
preserving behavior. Only edit that file. Leave uncertain cases unchanged.
```

All four frontmatter fields are required:

- `name`: nonempty string; trimmed; unique across every layer
- `step`: nonnegative safe integer; gaps are allowed
- `model`: nonempty string, passed exactly to Codex
- `reasoning_effort`: nonempty string, passed exactly through Codex configuration

Optional `scope` is a nonempty, single-line string. `PR`, `commit`, and descriptions
such as `src/payments: missing-user handling` are all literal text; no value is
resolved to a pull request, Git commit, changed-file list, or enforced boundary.
Quote YAML values that could otherwise parse as numbers, booleans, or null.

```yaml
scope: "PR"
```

Override every stage's scope for one invocation with `--scope <text>`:

```sh
passes run ./stages --scope "commit"
passes validate ./stages --scope "src/payments: missing-user handling"
```

The invocation value takes precedence over the stage's frontmatter. If either is
present, the first prompt line is `Scope: <value>`, followed by a blank line. If
neither is present, no scope line is added. Scope text is preserved exactly,
including surrounding spaces, but blank-only values, control/format characters,
and line separators are rejected. `validate` checks the option without running
agents. Supply `--scope` at most once.

The Markdown body must be nonempty and is preserved verbatim after any scope line,
followed by the standard commit instructions below. There are no
prompt variables, identifiers to configure, outputs, or artifact handoffs.
Unknown fields and YAML aliases/tags are rejected. Required strings are trimmed and may
not contain embedded control/format characters. Names need a letter or number;
case, accent, and punctuation normalization must not produce colliding slugs.

Discovery recursively reads regular `.md` files (case-insensitive extension), in
deterministic filename order. Symlink entries inside the directory are ignored.
Use a dedicated stage directory: every discovered Markdown file is a stage.

The examples are illustrative instructions targeting placeholder paths. Review
and adapt them before running. `gpt-6-luna` and `medium`/`high` were present in the
installed Codex 0.159.2 catalog when checked; your catalog/access can differ.

## Validation and graph

```sh
passes validate ./stages
```

Validation rejects malformed YAML, duplicate YAML keys, missing/unknown fields,
invalid types, empty prompts, duplicate trimmed names, and slug collisions. Errors
identify the stage file and field; multiple invalid files are reported together.
No agents run, no model catalog is queried, and no checkout files are modified.

A valid plan prints each numeric layer, its names/model/effort, barriers, and a
shared-checkout warning where concurrency is present.

## Execution

```sh
passes run ./stages
```

`run` performs the same validation, then checks that the invocation directory is
inside a Git working tree and that Codex supports the verified CLI protocol.
Before starting **any** stage, it queries `codex app-server`'s paginated
`model/list` catalog and checks all requested model/effort combinations. Unknown
models and unsupported efforts fail explicitly; there is no silent fallback.
The catalog probe sends only initialization and model-list requests and uses
explicit gateway authentication handling so it does not start a login flow.

Catalog compatibility does **not** establish current credentials, live account
entitlement, quota, or provider availability. Codex can return a bundled/cached
catalog; actual access failures are reported when the stage executes.

Each stage receives this argv shape, with no shell evaluation:

```text
codex exec --approve-for-me --model MODEL
  -c 'model_reasoning_effort="EFFORT"'
  --cd INVOCATION_DIRECTORY
  --color never --ephemeral -
```

With `--fast`, the catalog probe enables `fast_mode`. Models advertising a
`priority` or `fast` service tier receive `--enable fast_mode -c 'service_tier="fast"'`
during execution. The runner also recognizes the older `additionalSpeedTiers`
field when `serviceTiers` is empty or absent. Unsupported or unadvertised models
receive no service-tier override. A runtime failure is reported normally without
retrying the stage, since it may already have edited files or committed changes.

The model and effort come from the stage. The effort is encoded as a quoted TOML
string. Prompts go over stdin, avoiding shell interpretation and command-line
length limits. Codex's existing environment/provider settings are preserved.
`--approve-for-me` selects the workspace sandbox and routes escalation requests
through automatic approval review. It cannot be combined with `--sandbox`.
This lets stages request permission for Git writes such as `git add` and
`git commit`, since `.git` is read-only inside the
default workspace sandbox. Approval is still subject to policy; a denied request
can leave changes uncommitted.
`--ephemeral` avoids Codex session rollout persistence; the runner's separate log
still captures stage output. Codex may perform its normal local configuration/cache
operations. Stdout and stderr retain separate stage labels in the log and, with
`--verbose`, stream to their corresponding terminal channels.

Every stage prompt ends with these instructions:

> After completing the stage, inspect your changes and commit them. Use a short subject describing the outcome. In the body, explain why and show a compact Before → After sketch when useful. Record only checks actually run. Skip empty commits.

The model writes the commit message and performs the commit. This is an instruction,
not a runner-enforced guarantee: the runner does not stage files, create commits,
verify commit messages, or require a clean checkout. A successful process exit does
not prove that a commit was created. Review the resulting diff and Git history.

After every stage succeeds, the runner pushes committed history when a Git remote
exists. It runs `git -c push.autoSetupRemote=true push`, respecting Git's configured
push destination and setting an upstream for a new branch under the usual
`simple`, `current`, or `upstream` push defaults. This pushes the current branch's
pending commits, including any that existed before the run; it does not commit
remaining working-tree edits. Repositories without remotes skip this step.
Stage failure or cancellation prevents the push. Push failures (including missing
credentials, ambiguous destinations, and rejected updates) fail the run and retain
local commits. There is no forced push or automatic retry.

Effect controls concurrent fibers, sequential barriers, scoped process resources,
timeouts, and interruption. A failed stage prevents later layers from starting
and interrupts its siblings. SIGINT/SIGTERM interrupt all active work. Dedicated
POSIX process groups get SIGTERM, a 500 ms grace period, then SIGKILL if needed.
This also terminates ordinary descendants, including TERM-ignoring children.
Processes deliberately detaching into new sessions cannot be fully controlled by
this mechanism; stage commands should not daemonize. Windows execution is
explicitly unsupported rather than using incomplete tree cancellation.

Exit codes: `0` success, `1` validation/setup/stage/push/logging failure, `130` SIGINT,
`143` SIGTERM. A stage failure includes its actual exit code or signal.

## Shared-checkout safety

Concurrent stages can overwrite or interfere with one another, even if they
appear to concern different files. There is no edit isolation. Give overlapping
work different steps. The runner does not silently serialize a layer.

The runner does not create worktrees, fetch PRs, switch branches, commit, stash,
reset, or clean files. It does not discard existing changes on success, failure, or
cancellation. Codex is instructed to commit at the end of each stage, and stage
instructions determine what Codex edits or commits; review them before execution
and review resulting changes afterward. No mandatory review
stage or automatic rollback is imposed.

## Development

```sh
bun test             # CLI behavior tests with a fake Codex executable
bun run typecheck    # TypeScript strict mode
bun run lint         # Oxlint checks
bun run lint:fix     # apply Oxlint fixes
bun run format       # format with Oxfmt
bun run format:check # check Oxfmt formatting
bun run build        # bundled Bun entry point
bun run check        # typecheck, lint, formatting check, tests, and build
```

Tests exercise the CLI in temporary workspaces, using real Git repositories and a
fake Codex executable for execution. The subprocess `PATH` exposes only the chosen
tools; validation, help, and version also run without Git or Codex. Tests make no
inference requests, configure no real account, and do not modify a user's Git
working tree. See `TESTING.md`.

Runtime dependencies are Effect v4, `@effect/platform-bun`, `gray-matter`, and `yaml`.
The CLI provides `BunServices.layer` for platform services. Its filesystem,
process, path, and stdio implementations reuse `@effect/platform-node-shared`.
All three Effect packages resolve to 4.0.1; `bun run repos:sync` verifies their
manifests against the vendored release tree. Repository sync also runs in Effect,
reusing the filesystem services and scoped process spawner. Git commands retain
full output up to the previous 1 MiB per-stream bound; interruption or output
failure releases the process group with the same 500 ms escalation deadline.
Its application entrypoint uses `BunRuntime.runMain`; JSONC and JSON parsing each
have a single synchronous exception boundary.

Discovery keeps Node's directory entries to ignore symlinks without extra file
checks. Its single-operation adapter preserves native errors; `readdir` has no
abort option, so Effect interruption stops traversal without cancelling the
pending native read. Reads use `FileSystem.readFile` and Node UTF-8 decoding to
preserve BOMs; the service wires cancellation to the native read's abort signal.
Stage, scope, and catalog validation use Effect schema decoders directly.
`gray-matter` extracts frontmatter, with explicit checks requiring bare `---` fence
lines and preserving the prompt body exactly. Its default YAML engine is bypassed
so the `yaml` dependency continues to handle parsing and validation. YAML
parsing/conversion and JSON parsing have individual exception boundaries, and
contextual errors retain their causes. The YAML dependency retains full core-schema
parsing, duplicate-key diagnostics, and alias/tag rejection. Effect's YAML parser
supports a narrower grammar. Process execution uses Effect's scoped spawner with
bounded pipe draining and a 500 ms TERM-to-KILL deadline for descendants, including
after a nonzero leader exit. The platform owns cleanup without an extra runner
finalizer. The project deliberately avoids
worktree libraries, databases, external services, or a second workflow format.

## Codex references

Flags were checked against installed `codex --help`, `codex exec --help`, and
`codex app-server --help` for version 0.159.2, plus the generated app-server schema.

- [Non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode)
- [App-server models and protocol](https://learn.chatgpt.com/docs/app-server#models)
- [Reasoning configuration](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Catalog versus live entitlement](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
