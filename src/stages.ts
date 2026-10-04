import { Effect, FileSystem, Path, type PlatformError, Schema } from "effect";
import { parseDocument } from "yaml";
import { message, PassesError } from "./errors.ts";

const Text = Schema.String.check(Schema.isMinLength(1), Schema.isPattern(/^[^\p{Cc}\p{Cf}]+$/u));
const Metadata = Schema.Struct({
  name: Text,
  step: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  model: Text,
  reasoning_effort: Text,
});

export interface Stage {
  readonly name: string;
  readonly slug: string;
  readonly step: number;
  readonly model: string;
  readonly reasoning_effort: string;
  readonly prompt: string;
  readonly file: string;
}
export interface Layer {
  readonly step: number;
  readonly stages: readonly Stage[];
}
export interface Plan {
  readonly cwd: string;
  readonly directory: string;
  readonly stages: readonly Stage[];
  readonly layers: readonly Layer[];
}

export const slugify = (name: string): string =>
  name
    .normalize("NFKD")
    .replace(/\p{M}/gu, "")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-|-$/g, "");

export function parseStage(source: string, file: string): Stage {
  const match = /^\uFEFF?---[\t ]*\r?\n([\s\S]*?)^---[\t ]*\r?$(?:\n|$)([\s\S]*)/m.exec(source);
  // The multiline regexp allows the closing fence to anchor; enforce opening at byte zero.
  if (!match || match.index !== 0) {
    throw new PassesError({
      message: `${file}: frontmatter must start and end with a line containing ---`,
    });
  }
  const yaml = parseDocument(match[1] ?? "", { uniqueKeys: true, strict: true, schema: "core" });
  if (yaml.errors.length || yaml.warnings.length) {
    throw new PassesError({
      message: `${file}: YAML: ${[...yaml.errors, ...yaml.warnings].map((e) => e.message).join("; ")}`,
      cause: new AggregateError([...yaml.errors, ...yaml.warnings]),
    });
  }
  let raw: unknown;
  try {
    raw = yaml.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new PassesError({
      message: `${file}: YAML: ${message(error)} (aliases are not supported)`,
      cause: error,
    });
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    raw = Object.fromEntries(
      Object.entries(raw).map(([key, value]) => [
        key,
        typeof value === "string" ? value.trim() : value,
      ]),
    );
  }
  let metadata: typeof Metadata.Type;
  try {
    metadata = Schema.decodeUnknownSync(Metadata, { onExcessProperty: "error", errors: "all" })(
      raw,
    );
  } catch (error) {
    throw new PassesError({ message: `${file}: frontmatter: ${message(error)}`, cause: error });
  }
  if (!Number.isSafeInteger(metadata.step)) {
    throw new PassesError({ message: `${file}: step must be a nonnegative safe integer` });
  }
  const prompt = match[2] ?? "";
  if (!prompt.trim()) throw new PassesError({ message: `${file}: prompt body must not be empty` });
  if (prompt.includes("\0"))
    throw new PassesError({ message: `${file}: prompt body must not contain NUL bytes` });
  const slug = slugify(metadata.name);
  if (!slug)
    throw new PassesError({ message: `${file}: name must contain at least one letter or number` });
  return { ...metadata, slug, prompt, file };
}

export const loadPlan = Effect.fnUntraced(
  function* (directory: string, cwd: string) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const absolute = path.resolve(cwd, directory);
    if ((yield* fs.stat(absolute)).type !== "Directory")
      return yield* new PassesError({ message: `${absolute}: expected a stages directory` });
    const paths: string[] = [];
    const walk = Effect.fnUntraced(function* (
      dir: string,
    ): Effect.fn.Return<void, PlatformError.PlatformError> {
      const entries = (yield* fs.readDirectory(dir)).sort();
      for (const entry of entries) {
        const file = path.join(dir, entry);
        // FileSystem.stat follows links. Probe readLink first, including dangling links.
        const isLink = yield* fs.readLink(file).pipe(
          Effect.as(true),
          Effect.catch((error) =>
            (error.cause as NodeJS.ErrnoException | undefined)?.code === "EINVAL"
              ? Effect.succeed(false)
              : Effect.fail(error),
          ),
        );
        if (isLink) continue;
        const info = yield* fs.stat(file);
        if (info.type === "Directory") yield* walk(file);
        else if (info.type === "File" && /\.md$/i.test(entry)) paths.push(file);
      }
    });
    yield* walk(absolute);
    if (!paths.length)
      return yield* new PassesError({ message: `${directory}: no Markdown (.md) stages found` });
    const stages: Stage[] = [];
    const errors: (PassesError | PlatformError.PlatformError)[] = [];
    const names = new Map<string, string>();
    const slugs = new Map<string, string>();
    for (const filename of paths) {
      const file = path.relative(cwd, filename) || filename;
      yield* Effect.gen(function* () {
        const source = yield* fs.readFileString(filename);
        const stage = yield* Effect.try({
          try: () => parseStage(source, file),
          catch: (error) =>
            error instanceof PassesError
              ? error
              : new PassesError({ message: message(error), cause: error }),
        });
        const duplicate = names.get(stage.name);
        const collision = slugs.get(stage.slug);
        if (duplicate)
          return yield* new PassesError({
            message: `${file}: name "${stage.name}" duplicates ${duplicate}`,
          });
        if (collision)
          return yield* new PassesError({
            message: `${file}: name "${stage.name}" has slug "${stage.slug}", which collides with ${collision}`,
          });
        names.set(stage.name, file);
        slugs.set(stage.slug, file);
        stages.push(stage);
      }).pipe(
        Effect.catch((error) =>
          Effect.sync(() => {
            errors.push(error);
          }),
        ),
      );
    }
    if (errors.length)
      return yield* new PassesError({
        message: `Invalid stage configuration:\n${errors.map((e) => `  ${message(e)}`).join("\n")}`,
        cause: new AggregateError(errors),
      });
    const steps = [...new Set(stages.map((s) => s.step))].sort((a, b) => a - b);
    return {
      cwd,
      directory: absolute,
      stages,
      layers: steps.map((step) => ({ step, stages: stages.filter((s) => s.step === step) })),
    } satisfies Plan;
  },
  Effect.mapError((error) =>
    error instanceof PassesError
      ? error
      : new PassesError({ message: `Could not read stages: ${message(error)}`, cause: error }),
  ),
);

export function renderGraph(plan: Plan): string {
  const lines = [
    `Valid: ${plan.stages.length} stages, ${plan.layers.length} layers`,
    `Working directory: ${plan.cwd}`,
    "",
  ];
  for (const [index, layer] of plan.layers.entries()) {
    const concurrent = layer.stages.length > 1;
    lines.push(`Step ${layer.step}${concurrent ? "  [concurrent, shared checkout]" : ""}`);
    for (const stage of layer.stages)
      lines.push(`  +-- ${stage.name}  [${stage.model}, effort=${stage.reasoning_effort}]`);
    if (index < plan.layers.length - 1)
      lines.push(
        `  |`,
        `  +-- wait for ${concurrent ? "all stages" : "stage"}`,
        `      |`,
        `      v`,
      );
  }
  if (plan.layers.some((layer) => layer.stages.length > 1))
    lines.push("", "Warning: concurrent stages share files; edits are not isolated.");
  lines.push("", "Configuration valid. Model/effort compatibility is checked before run.");
  return lines.join("\n");
}
