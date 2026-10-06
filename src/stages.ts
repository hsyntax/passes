import { readdir } from "node:fs/promises";
import { Effect, FileSystem, Path, Result, Schema } from "effect";
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

export const parseScope = (scope: unknown) =>
  Schema.decodeUnknownEffect(ScopeString)(scope).pipe(
    Effect.mapError(
      (cause) =>
        new PassesError(
          "scope must be a nonempty single-line string without control or format characters",
          { cause },
        ),
    ),
  );

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
  readonly invocationDirectory: string;
  readonly stagesDirectory: string;
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

export const parseStage = Effect.fn(function* (source: string, file: string) {
  const match = /^\uFEFF?---[\t ]*\r?\n([\s\S]*?)^---[\t ]*\r?$(?:\n|$)([\s\S]*)/m.exec(source);
  // The multiline regexp allows the closing fence to anchor; enforce opening at byte zero.
  if (!match || match.index !== 0) {
    return yield* Effect.fail(
      new PassesError(`${file}: frontmatter must start and end with a line containing ---`),
    );
  }
  const yaml = yield* Effect.try({
    try: () => parseDocument(match[1] ?? "", { uniqueKeys: true, strict: true, schema: "core" }),
    catch: (cause) => new PassesError(`${file}: YAML: ${message(cause)}`, { cause }),
  });
  if (yaml.errors.length || yaml.warnings.length) {
    return yield* Effect.fail(
      new PassesError(
        `${file}: YAML: ${[...yaml.errors, ...yaml.warnings].map((e) => e.message).join("; ")}`,
        { cause: [...yaml.errors, ...yaml.warnings] },
      ),
    );
  }
  const frontmatter: unknown = yield* Effect.try({
    try: () => yaml.toJS({ maxAliasCount: 0 }),
    catch: (cause) =>
      new PassesError(`${file}: YAML: ${message(cause)} (aliases are not supported)`, { cause }),
  }).pipe(
    Effect.map((frontmatter) =>
      frontmatter && typeof frontmatter === "object" && !Array.isArray(frontmatter)
        ? Object.fromEntries(
            Object.entries(frontmatter).map(([key, value]) => [
              key,
              typeof value === "string" && key !== "scope" ? value.trim() : value,
            ]),
          )
        : frontmatter,
    ),
  );
  const stageFrontmatter = yield* Schema.decodeUnknownEffect(StageFrontmatterSchema, {
    onExcessProperty: "error",
    errors: "all",
  })(frontmatter).pipe(
    Effect.mapError(
      (cause) => new PassesError(`${file}: frontmatter: ${message(cause)}`, { cause }),
    ),
  );
  if (!Number.isSafeInteger(stageFrontmatter.step)) {
    return yield* Effect.fail(new PassesError(`${file}: step must be a nonnegative safe integer`));
  }
  const prompt = match[2] ?? "";
  if (!prompt.trim())
    return yield* Effect.fail(new PassesError(`${file}: prompt body must not be empty`));
  if (prompt.includes("\0"))
    return yield* Effect.fail(new PassesError(`${file}: prompt body must not contain NUL bytes`));
  const slug = stageSlug(stageFrontmatter.name);
  if (!slug)
    return yield* Effect.fail(
      new PassesError(`${file}: name must contain at least one letter or number`),
    );
  return { ...stageFrontmatter, slug, prompt, file };
});

// The platform API returns names only; Dirent flags preserve the no-symlink walk.
// readdir has no abort option: interruption stops the fiber, not the native read.
const readDirectoryEntries = (directory: string) =>
  Effect.tryPromise({
    try: () => readdir(directory, { withFileTypes: true }),
    catch: (error) => error,
  });

const discoverStageFiles = Effect.fn((stagesDirectory: string) =>
  Effect.gen(function* () {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const directory = yield* fs
      .stat(stagesDirectory)
      .pipe(Effect.mapError((error) => error.cause ?? error));
    if (directory.type !== "Directory")
      return yield* Effect.fail(new PassesError(`${stagesDirectory}: expected a stages directory`));
    const stageFiles: string[] = [];
    const walk: (dir: string) => Effect.Effect<void, unknown, never> = Effect.fn((dir: string) =>
      Effect.gen(function* () {
        const entries = yield* readDirectoryEntries(dir);
        entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
        for (const entry of entries) {
          const entryPath = path.join(dir, entry.name);
          // Never follow links, including links that could leave the supplied stage tree.
          if (entry.isDirectory()) yield* walk(entryPath);
          else if (entry.isFile() && /\.md$/i.test(entry.name)) stageFiles.push(entryPath);
        }
      }),
    );
    yield* walk(stagesDirectory);
    return stageFiles;
  }),
);

export const loadPlan = Effect.fn("Stages.loadPlan")(
  (stagesDirectory: string, invocationDirectory: string) =>
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const absoluteStagesDirectory = path.resolve(invocationDirectory, stagesDirectory);
      const stageFiles = yield* discoverStageFiles(absoluteStagesDirectory);
      if (!stageFiles.length)
        return yield* Effect.fail(
          new PassesError(`${stagesDirectory}: no Markdown (.md) stages found`),
        );
      const stages: Stage[] = [];
      const errors: unknown[] = [];
      const stageNames = new Map<string, string>();
      const stageSlugs = new Map<string, string>();
      for (const stagePath of stageFiles) {
        const file = path.relative(invocationDirectory, stagePath) || stagePath;
        const source = yield* fs.readFile(stagePath).pipe(
          Effect.mapError((error) => error.cause ?? error),
          // Match Node's UTF-8 decoding, including preservation of a leading BOM.
          Effect.map((source) => Buffer.from(source).toString("utf8")),
          Effect.result,
        );
        if (Result.isFailure(source)) {
          errors.push(source.failure);
          continue;
        }
        const result = yield* Effect.result(parseStage(source.success, file));
        if (Result.isFailure(result)) {
          errors.push(result.failure);
          continue;
        }
        const stage = result.success;
        const duplicate = stageNames.get(stage.name);
        const collision = stageSlugs.get(stage.slug);
        if (duplicate) {
          errors.push(`${file}: name "${stage.name}" duplicates ${duplicate}`);
          continue;
        }
        if (collision) {
          errors.push(
            `${file}: name "${stage.name}" has slug "${stage.slug}", which collides with ${collision}`,
          );
          continue;
        }
        stageNames.set(stage.name, file);
        stageSlugs.set(stage.slug, file);
        stages.push(stage);
      }
      if (errors.length) {
        return yield* Effect.fail(
          new PassesError(
            `Invalid stage configuration:\n${errors.map((e) => `  ${message(e)}`).join("\n")}`,
            { cause: errors },
          ),
        );
      }
      const layersByStep = new Map<number, Stage[]>();
      for (const stage of stages) {
        const layer = layersByStep.get(stage.step);
        if (layer) layer.push(stage);
        else layersByStep.set(stage.step, [stage]);
      }
      return {
        invocationDirectory,
        stagesDirectory: absoluteStagesDirectory,
        stages,
        layers: [...layersByStep]
          .sort(([left], [right]) => left - right)
          .map(([step, layerStages]) => ({ step, stages: layerStages })),
      };
    }).pipe(
      Effect.mapError((error) =>
        error instanceof PassesError
          ? error
          : new PassesError(`Could not read stages: ${message(error)}`, { cause: error }),
      ),
    ),
);

export function renderPlanGraph(plan: Plan): string {
  const lines = [
    `Valid: ${plan.stages.length} stages, ${plan.layers.length} layers`,
    `Working directory: ${plan.invocationDirectory}`,
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
