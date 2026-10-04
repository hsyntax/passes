import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative, resolve } from "node:path";
import { Effect, Schema } from "effect";
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
    throw new PassesError(`${file}: frontmatter: ${message(error)}`);
  }
  if (!Number.isSafeInteger(metadata.step)) {
    throw new PassesError(`${file}: step must be a nonnegative safe integer`);
  }
  const prompt = match[2] ?? "";
  if (!prompt.trim()) throw new PassesError(`${file}: prompt body must not be empty`);
  if (prompt.includes("\0"))
    throw new PassesError(`${file}: prompt body must not contain NUL bytes`);
  const slug = slugify(metadata.name);
  if (!slug) throw new PassesError(`${file}: name must contain at least one letter or number`);
  return { ...metadata, slug, prompt, file };
}

async function discover(directory: string): Promise<string[]> {
  if (!(await stat(directory)).isDirectory())
    throw new PassesError(`${directory}: expected a stages directory`);
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    const entries = await readdir(dir, { withFileTypes: true });
    entries.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
    for (const entry of entries) {
      const path = join(dir, entry.name);
      // Never follow links, including links that could leave the supplied stage tree.
      if (entry.isDirectory()) await walk(path);
      else if (entry.isFile() && /\.md$/i.test(entry.name)) files.push(path);
    }
  }
  await walk(directory);
  return files;
}

export const loadPlan = (directory: string, cwd: string) =>
  Effect.tryPromise({
    try: async (): Promise<Plan> => {
      const absolute = resolve(cwd, directory);
      const paths = await discover(absolute);
      if (!paths.length) throw new PassesError(`${directory}: no Markdown (.md) stages found`);
      const stages: Stage[] = [];
      const errors: string[] = [];
      const names = new Map<string, string>();
      const slugs = new Map<string, string>();
      for (const path of paths) {
        const file = relative(cwd, path) || path;
        try {
          const stage = parseStage(await readFile(path, "utf8"), file);
          const duplicate = names.get(stage.name);
          const collision = slugs.get(stage.slug);
          if (duplicate)
            throw new PassesError(`${file}: name "${stage.name}" duplicates ${duplicate}`);
          if (collision)
            throw new PassesError(
              `${file}: name "${stage.name}" has slug "${stage.slug}", which collides with ${collision}`,
            );
          names.set(stage.name, file);
          slugs.set(stage.slug, file);
          stages.push(stage);
        } catch (error) {
          errors.push(message(error));
        }
      }
      if (errors.length)
        throw new PassesError(
          `Invalid stage configuration:\n${errors.map((e) => `  ${e}`).join("\n")}`,
        );
      const steps = [...new Set(stages.map((s) => s.step))].sort((a, b) => a - b);
      return {
        cwd,
        directory: absolute,
        stages,
        layers: steps.map((step) => ({ step, stages: stages.filter((s) => s.step === step) })),
      };
    },
    catch: (error) =>
      error instanceof PassesError
        ? error
        : new PassesError(`Could not read stages: ${message(error)}`),
  });

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
