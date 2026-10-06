import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { Effect, Schema } from "effect";
import { parseDocument } from "yaml";
import { message, PassesError } from "./errors.ts";

const FrontmatterText = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isPattern(/^[^\p{Cc}\p{Cf}]+$/u),
);
const ScopeText = FrontmatterText.check(
  Schema.isPattern(/\S/),
  Schema.isPattern(/^[^\p{Zl}\p{Zp}]+$/u),
);
const StageFrontmatter = Schema.Struct({
  name: FrontmatterText,
  step: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  model: FrontmatterText,
  reasoning_effort: FrontmatterText,
  scope: Schema.optionalKey(ScopeText),
});

export function parseScope(value: unknown): string {
  try {
    return Schema.decodeUnknownSync(ScopeText)(value);
  } catch {
    throw new PassesError(
      "scope must be a nonempty single-line string without control or format characters",
    );
  }
}

export interface Stage {
  readonly name: string;
  readonly slug: string;
  readonly step: number;
  readonly model: string;
  readonly reasoning_effort: string;
  readonly scope?: string;
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
    throw new PassesError(`${file}: frontmatter must start and end with a line containing ---`);
  }
  const yaml = parseDocument(match[1] ?? "", { uniqueKeys: true, strict: true, schema: "core" });
  if (yaml.errors.length || yaml.warnings.length) {
    throw new PassesError(
      `${file}: YAML: ${[...yaml.errors, ...yaml.warnings].map((e) => e.message).join("; ")}`,
    );
  }
  let raw: unknown;
  try {
    raw = yaml.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new PassesError(`${file}: YAML: ${message(error)} (aliases are not supported)`);
  }
  if (raw && typeof raw === "object" && !Array.isArray(raw)) {
    raw = Object.fromEntries(
      Object.entries(raw).map(([key, value]) => [
        key,
        typeof value === "string" && key !== "scope" ? value.trim() : value,
      ]),
    );
  }
  let stageFrontmatter: typeof StageFrontmatter.Type;
  try {
    stageFrontmatter = Schema.decodeUnknownSync(StageFrontmatter, {
      onExcessProperty: "error",
      errors: "all",
    })(raw);
  } catch (error) {
    throw new PassesError(`${file}: frontmatter: ${message(error)}`);
  }
  if (!Number.isSafeInteger(stageFrontmatter.step)) {
    throw new PassesError(`${file}: step must be a nonnegative safe integer`);
  }
  const prompt = match[2] ?? "";
  if (!prompt.trim()) throw new PassesError(`${file}: prompt body must not be empty`);
  if (prompt.includes("\0"))
    throw new PassesError(`${file}: prompt body must not contain NUL bytes`);
  const slug = slugify(stageFrontmatter.name);
  if (!slug) throw new PassesError(`${file}: name must contain at least one letter or number`);
  return { ...stageFrontmatter, slug, prompt, file };
}

function discoverStageFiles(stagesDirectory: string): Effect.Effect<string[], unknown, never> {
  return Effect.gen(function* () {
    const directory = yield* Effect.tryPromise({
      try: () => stat(stagesDirectory),
      catch: (error) => error,
    });
    if (!directory.isDirectory())
      return yield* Effect.fail(new PassesError(`${stagesDirectory}: expected a stages directory`));
    const stageFiles: string[] = [];
    const walk = (dir: string): Effect.Effect<void, unknown, never> =>
      Effect.gen(function* () {
        const entries = yield* Effect.tryPromise({
          try: () => readdir(dir, { withFileTypes: true }),
          catch: (error) => error,
        });
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of entries) {
          const path = join(dir, entry.name);
          // Never follow links, including links that could leave the supplied stage tree.
          if (entry.isDirectory()) yield* walk(path);
          else if (entry.isFile() && /\.md$/i.test(entry.name)) stageFiles.push(path);
        }
      });
    yield* walk(stagesDirectory);
    return stageFiles;
  });
}

export const loadPlan = Effect.fn("Stages.loadPlan")((stageDirectory: string, cwd: string) =>
  Effect.gen(function* () {
    const absolute = resolve(cwd, stageDirectory);
    const stageFiles = yield* discoverStageFiles(absolute);
    if (!stageFiles.length)
      return yield* Effect.fail(
        new PassesError(`${stageDirectory}: no Markdown (.md) stages found`),
      );
    const stages: Stage[] = [];
    const errors: string[] = [];
    const stageNames = new Map<string, string>();
    const stageSlugs = new Map<string, string>();
    for (const path of stageFiles) {
      const file = relative(cwd, path) || path;
      try {
        const source = yield* Effect.match(
          Effect.tryPromise({
            try: (signal) => readFile(path, { encoding: "utf8", signal }),
            catch: (error) => new PassesError(message(error)),
          }),
          {
            onFailure: (error) => {
              errors.push(message(error));
              return undefined;
            },
            onSuccess: (source) => source,
          },
        );
        if (source === undefined) continue;
        const stage = parseStage(source, file);
        const duplicate = stageNames.get(stage.name);
        const collision = stageSlugs.get(stage.slug);
        if (duplicate)
          throw new PassesError(`${file}: name "${stage.name}" duplicates ${duplicate}`);
        if (collision)
          throw new PassesError(
            `${file}: name "${stage.name}" has slug "${stage.slug}", which collides with ${collision}`,
          );
        stageNames.set(stage.name, file);
        stageSlugs.set(stage.slug, file);
        stages.push(stage);
      } catch (error) {
        errors.push(message(error));
      }
    }
    if (errors.length) {
      return yield* Effect.fail(
        new PassesError(`Invalid stage configuration:\n${errors.map((e) => `  ${e}`).join("\n")}`),
      );
    }
    const steps = [...new Set(stages.map((s) => s.step))].sort((a, b) => a - b);
    return {
      cwd,
      directory: absolute,
      stages,
      layers: steps.map((step) => ({ step, stages: stages.filter((s) => s.step === step) })),
    };
  }).pipe(
    Effect.mapError((error) =>
      error instanceof PassesError
        ? error
        : new PassesError(`Could not read stages: ${message(error)}`),
    ),
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
