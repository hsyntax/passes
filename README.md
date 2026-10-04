# passes

A small TypeScript + Effect + Bun runner for Markdown-defined Codex stages.
Stages with the same `step` run concurrently in the existing checkout. Layers run
in ascending numeric order, with a full barrier between layers.

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

The Markdown body must be nonempty and is sent unchanged over stdin. There are no
prompt variables, identifiers to configure, outputs, or artifact handoffs.
Unknown fields and YAML aliases/tags are rejected. Strings are trimmed and may
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
codex --ask-for-approval never exec --model MODEL
  -c 'model_reasoning_effort="EFFORT"'
  --sandbox workspace-write --cd INVOCATION_DIRECTORY
  --color never --ephemeral -
```

The model and effort come from the stage. The effort is encoded as a quoted TOML
string. Prompts go over stdin, avoiding shell interpretation and command-line
length limits. Codex's existing environment/provider settings are preserved.
`--ephemeral` avoids Codex session rollout persistence; the runner creates no
logs, artifacts, or output directories. Codex may still perform its normal local
configuration/cache operations. Stdout and stderr are streamed separately with
stage labels; partial lines are flushed on completion/cancellation.

Effect controls concurrent fibers, sequential barriers, scoped process resources,
timeouts, and interruption. A failed stage prevents later layers from starting
and interrupts its siblings. SIGINT/SIGTERM interrupt all active work. Dedicated
POSIX process groups get SIGTERM, a 500 ms grace period, then SIGKILL if needed.
This also terminates ordinary descendants, including TERM-ignoring children.
Processes deliberately detaching into new sessions cannot be fully controlled by
this mechanism; stage commands should not daemonize. Windows execution is
explicitly unsupported rather than using incomplete tree cancellation.

Exit codes: `0` success, `1` validation/setup/stage failure, `130` SIGINT,
`143` SIGTERM. A stage failure includes its actual exit code or signal.

## Shared-checkout safety

Concurrent stages can overwrite or interfere with one another, even if they
appear to concern different files. There is no edit isolation. Give overlapping
work different steps. The runner does not silently serialize a layer.

The runner does not create worktrees, fetch PRs, switch branches, commit, stash,
reset, or clean files. Existing changes are retained on success, failure, and
cancellation. Stage instructions still determine what Codex edits; review them
before execution and review resulting changes afterward. No mandatory review
stage or automatic rollback is imposed.

## Development

```sh
bun test          # parser/discovery/unit + stubbed CLI integration tests
bun run typecheck # TypeScript strict mode
bun run lint      # Biome check
bun run build     # bundled Bun entry point
bun run check     # all of the above
```

All tests use temporary Git repositories and a fake Codex executable placed first
on the subprocess `PATH`. They make no inference requests, configure no real
account, and do not modify a user's Git working tree. See `TESTING.md`.

Runtime dependencies are Effect v4 and `yaml`. The project deliberately avoids
worktree libraries, databases, external services, or a second workflow format.

## Codex references

Flags were checked against installed `codex --help`, `codex exec --help`, and
`codex app-server --help` for version 0.159.2, plus the generated app-server schema.

- [Non-interactive execution](https://learn.chatgpt.com/docs/non-interactive-mode)
- [App-server models and protocol](https://learn.chatgpt.com/docs/app-server#models)
- [Reasoning configuration](https://learn.chatgpt.com/docs/config-file/config-reference)
- [Catalog versus live entitlement](https://developers.openai.com/siwc/token-sharing-open-source/codex-app-server)
