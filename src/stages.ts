import { layer as fileSystemLayer } from "@effect/platform-node-shared/NodeFileSystem";
import { readdir } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { Effect, FileSystem, Schema } from "effect";
import { parseDocument } from "yaml";
import { message, PassesError } from "./errors.ts";

const FrontmatterString = Schema.String.check(
  Schema.isMinLength(1),
  Schema.isPattern(/^[^\p{Cc}\p{Cf}]+$/u),
);
const ScopeString = FrontmatterString.check(
  Schema.isPattern(/\S/),
  Schema.isPattern(/^[^\p{Zl}\p{Zp}]+$/u),
);
const StageFrontmatterSchema = Schema.Struct({
  name: FrontmatterString,
  step: Schema.Number.check(Schema.isInt(), Schema.isGreaterThanOrEqualTo(0)),
  model: FrontmatterString,
  reasoning_effort: FrontmatterString,
  scope: Schema.optionalKey(ScopeString),
});

export function parseScope(scope: unknown): string {
  try {
    return Schema.decodeUnknownSync(ScopeString)(scope);
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

export const stageSlug = (stageName: string): string =>
  stageName
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
  let frontmatter: unknown;
  try {
    frontmatter = yaml.toJS({ maxAliasCount: 0 });
  } catch (error) {
    throw new PassesError(`${file}: YAML: ${message(error)} (aliases are not supported)`);
  }
  if (frontmatter && typeof frontmatter === "object" && !Array.isArray(frontmatter)) {
    frontmatter = Object.fromEntries(
      Object.entries(frontmatter).map(([key, value]) => [
        key,
        typeof value === "string" && key !== "scope" ? value.trim() : value,
      ]),
    );
  }
  let stageFrontmatter: typeof StageFrontmatterSchema.Type;
  try {
    stageFrontmatter = Schema.decodeUnknownSync(StageFrontmatterSchema, {
      onExcessProperty: "error",
      errors: "all",
    })(frontmatter);
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
  const slug = stageSlug(stageFrontmatter.name);
  if (!slug) throw new PassesError(`${file}: name must contain at least one letter or number`);
  return { ...stageFrontmatter, slug, prompt, file };
}

const discoverStageFiles = Effect.fn((stagesDirectory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const directory = yield* fs
      .stat(stagesDirectory)
      .pipe(Effect.mapError((error) => error.cause ?? error));
    if (directory.type !== "Directory")
      return yield* Effect.fail(new PassesError(`${stagesDirectory}: expected a stages directory`));
    const stageFiles: string[] = [];
    const walk: (dir: string) => Effect.Effect<void, unknown, never> = Effect.fn((dir: string) =>
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
      }),
    );
    yield* walk(stagesDirectory);
    return stageFiles;
  }),
);

export const loadPlan = Effect.fn("Stages.loadPlan")((stageDirectory: string, cwd: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
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
        const source = yield* Effect.match(fs.readFile(path), {
          onFailure: (error) => {
            errors.push(message(error.cause ?? error));
            return undefined;
          },
          // Match Node's UTF-8 decoding, including preservation of a leading BOM.
          onSuccess: (source) => Buffer.from(source).toString("utf8"),
        });
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
    const layersByStep = new Map<number, Stage[]>();
    for (const stage of stages) {
      const layer = layersByStep.get(stage.step);
      if (layer) layer.push(stage);
      else layersByStep.set(stage.step, [stage]);
    }
    return {
      cwd,
      directory: absolute,
      stages,
      layers: [...layersByStep]
        .sort(([left], [right]) => left - right)
        .map(([step, layerStages]) => ({ step, stages: layerStages })),
    };
  }).pipe(
    Effect.provide(fileSystemLayer),
    Effect.mapError((error) =>
      error instanceof PassesError
        ? error
        : new PassesError(`Could not read stages: ${message(error)}`),
    ),
  ),
);

export function renderPlanGraph(plan: Plan): string {
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
