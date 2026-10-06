import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { execArgs, stagePrompt } from "../src/codex.ts";
import { lineReporter } from "../src/process.ts";
import { loadPlan, parseStage, renderGraph, slugify } from "../src/stages.ts";

const header = "name: Example\nstep: 0\nmodel: mock-model\nreasoning_effort: medium";
const document = (yaml = header, body = "Do the work.\n") => `---\n${yaml}\n---\n${body}`;
const roots: string[] = [];
afterEach(async () => {
  await Promise.all(roots.splice(0).map((path) => rm(path, { recursive: true, force: true })));
});
async function root() {
  const path = await mkdtemp(join(tmpdir(), "passes-stages-"));
  roots.push(path);
  return path;
}

describe("frontmatter", () => {
  test("trims metadata, preserves the exact Markdown body, and derives a stable slug", () => {
    // Stage bodies are deliberately literal.
    const body = "\n# Prompt\n${not_a_variable}\n---\nLiteral shell text: $(touch nope)\n";
    const stage = parseStage(
      document(header.replace("Example", '"  Héllo, World!  "'), body),
      "example.md",
    );
    expect(stage.name).toBe("Héllo, World!");
    expect(stage.slug).toBe("hello-world");
    expect(stage.prompt).toBe(body);
    expect(slugify("日本語 名前")).toBe("日本語-名前");
  });
  test("accepts BOM, CRLF, quoted scalars, comments and valid YAML block text", () => {
    const text =
      '\uFEFF---\r\nname: "Example" # comment\r\nstep: 2\r\nmodel: mock-model\r\nreasoning_effort: >-\r\n  medium\r\n---\r\nPrompt\r\n';
    const stage = parseStage(text, "crlf.md");
    expect(stage.step).toBe(2);
    expect(stage.reasoning_effort).toBe("medium");
    expect(stage.prompt).toBe("Prompt\r\n");
  });
  test("leaves scope undefined when the optional field is absent", () => {
    expect(parseStage(document(), "unscoped.md").scope).toBeUndefined();
  });
  test.each([
    "PR",
    "commit",
    "Review only the files under src/parser",
    "  Preserve surrounding spaces  ",
    "日本語 🌍: check the Before → After behavior",
    "$(touch nope); `touch nope`; ${literal} | cat > nope",
  ])("accepts arbitrary literal scope text without normalizing it: %j", (scope) => {
    const body = "\n# Instructions\nKeep this body unchanged.\n";
    const stage = parseStage(
      document(`${header}\nscope: ${JSON.stringify(scope)}`, body),
      "scoped.md",
    );
    expect(stage.scope).toBe(scope);
    expect(stage.prompt).toBe(body);
  });
  test("accepts a plain YAML scope scalar without treating it as an enum", () => {
    const stage = parseStage(
      document(`${header}\nscope: files changed since yesterday`),
      "scope.md",
    );
    expect(stage.scope).toBe("files changed since yesterday");
  });
  test.each(
    [
      null,
      true,
      123,
      ["PR"],
      { kind: "commit" },
      "",
      "   ",
      "\u00a0\u3000",
      "one\ntwo",
      "one\rtwo",
      "\tPR",
      "PR\t",
      "hello\u001b[31m",
      "hello\u007f",
      "hello\u0085world",
      "hello\u200bworld",
      "\ufeffPR",
      "one\u2028two",
      "one\u2029two",
    ].map((scope) => ({ scope })),
  )("rejects invalid scope with file and field context: %j", ({ scope }) => {
    const source = document(`${header}\nscope: ${JSON.stringify(scope)}`);
    expect(() => parseStage(source, "invalid-scope.md")).toThrow("invalid-scope.md");
    expect(() => parseStage(source, "invalid-scope.md")).toThrow("scope");
  });
  const bad: [string, string, string][] = [
    ["missing name", "step: 0\nmodel: x\nreasoning_effort: high", "name"],
    ["missing step", "name: Example\nmodel: x\nreasoning_effort: high", "step"],
    ["missing model", "name: Example\nstep: 0\nreasoning_effort: high", "model"],
    ["missing effort", "name: Example\nstep: 0\nmodel: x", "reasoning_effort"],
    ["empty name", header.replace("Example", '"  "'), "name"],
    ["non-string name", header.replace("Example", "[example]"), "name"],
    ["negative step", header.replace("step: 0", "step: -1"), "step"],
    ["fractional step", header.replace("step: 0", "step: 0.5"), "step"],
    ["infinite step", header.replace("step: 0", "step: .inf"), "step"],
    ["NaN step", header.replace("step: 0", "step: .nan"), "step"],
    ["boolean step", header.replace("step: 0", "step: true"), "step"],
    ["quoted step", header.replace("step: 0", 'step: "0"'), "step"],
    ["unsafe step", header.replace("step: 0", "step: 9007199254740992"), "step"],
    ["empty model", header.replace("mock-model", '""'), "model"],
    ["numeric model", header.replace("mock-model", "123"), "model"],
    ["empty effort", header.replace("medium", '" "'), "reasoning_effort"],
    ["boolean effort", header.replace("medium", "true"), "reasoning_effort"],
    ["unknown id", `${header}\nid: x`, "id"],
    ["unknown outputs", `${header}\noutputs: []`, "outputs"],
    ["unknown parallel", `${header}\nparallel: true`, "parallel"],
    ["duplicate YAML key", `${header}\nstep: 2`, "YAML"],
    ["malformed YAML", `${header}\nextra: [`, "YAML"],
    ["top-level array", "- name: A\n- step: 0", "frontmatter"],
    [
      "YAML alias",
      header.replace("name: Example", "name: &n Example").replace("model: mock-model", "model: *n"),
      "YAML",
    ],
    ["unsupported YAML tag", header.replace("Example", "!custom Example"), "YAML"],
    ["multiline name", header.replace("Example", '"one\\ntwo"'), "name"],
    ["terminal control", header.replace("Example", '"hello\\e[31m"'), "name"],
    ["empty derived slug", header.replace("Example", '"!!!"'), "name"],
  ];
  for (const [label, yaml, field] of bad) {
    test(`rejects ${label} with file and field context`, () => {
      try {
        parseStage(document(yaml), "bad.md");
        throw new Error("unexpected success");
      } catch (error) {
        expect(String(error)).toContain("bad.md");
        expect(String(error)).toContain(field);
      }
    });
  }
  for (const source of [
    "No frontmatter",
    `\n${document()}`,
    document().replace(/---\n/, ""),
    "---\nname: missing close",
    document(header, " \r\n\t"),
    document(header, "prompt\0"),
  ]) {
    test("rejects missing fences or invalid prompt", () => {
      expect(() => parseStage(source, "bad.md")).toThrow("bad.md");
    });
  }
});

describe("discovery and graph", () => {
  test("discovers nested Markdown deterministically, ignores symlinks and non-Markdown, and orders numeric layers", async () => {
    const cwd = await root();
    const dir = join(cwd, "stages");
    await mkdir(join(dir, "nested"), { recursive: true });
    await writeFile(
      join(dir, "z.MD"),
      document(header.replace("Example", "Last").replace("step: 0", "step: 20")),
    );
    await writeFile(join(dir, "b.md"), document(header.replace("Example", "Second")));
    await writeFile(join(dir, "a.md"), document(header.replace("Example", "First")));
    await writeFile(
      join(dir, "nested", "later.md"),
      document(header.replace("Example", "Later").replace("step: 0", "step: 3")),
    );
    await writeFile(join(dir, "ignored.txt"), "not a stage");
    await symlink(join(dir, "a.md"), join(dir, "linked.md"));
    await symlink(dir, join(dir, "cycle"));
    const plan = await Effect.runPromise(loadPlan("./stages", cwd));
    expect(plan.stages.map((s) => s.name)).toEqual(["First", "Second", "Later", "Last"]);
    expect(plan.layers.map((l) => l.step)).toEqual([0, 3, 20]);
    expect(plan.layers[0]?.stages.map((s) => s.name)).toEqual(["First", "Second"]);
    const graph = renderGraph(plan);
    expect(graph).toContain("Valid: 4 stages, 3 layers");
    expect(graph).toContain("wait for all stages");
    expect(graph).toContain("[concurrent, shared checkout]");
    expect(graph.indexOf("Step 3")).toBeLessThan(graph.indexOf("Step 20"));
  });
  test("rejects trimmed duplicate names across different steps", async () => {
    const cwd = await root();
    await writeFile(join(cwd, "a.md"), document());
    await writeFile(
      join(cwd, "b.md"),
      document(header.replace("Example", '" Example "').replace("step: 0", "step: 8")),
    );
    await expect(Effect.runPromise(loadPlan(".", cwd))).rejects.toThrow(
      'name "Example" duplicates a.md',
    );
  });
  test("rejects case, punctuation and accent slug collisions across steps", async () => {
    const cwd = await root();
    await writeFile(join(cwd, "a.md"), document(header.replace("Example", "Hello World")));
    await writeFile(
      join(cwd, "b.md"),
      document(header.replace("Example", "Héllo-world!").replace("step: 0", "step: 2")),
    );
    await expect(Effect.runPromise(loadPlan(".", cwd))).rejects.toThrow('slug "hello-world"');
  });
  test("aggregates file-specific configuration errors", async () => {
    const cwd = await root();
    await writeFile(join(cwd, "a.md"), document(header.replace("step: 0", "step: -1")));
    await writeFile(join(cwd, "b.md"), document(`${header}\noutputs: []`));
    try {
      await Effect.runPromise(loadPlan(".", cwd));
      throw new Error("unexpected success");
    } catch (error) {
      expect(String(error)).toContain("a.md");
      expect(String(error)).toContain("b.md");
    }
  });
  test("rejects empty sets, files instead of directories, and missing directories", async () => {
    const cwd = await root();
    await expect(Effect.runPromise(loadPlan(".", cwd))).rejects.toThrow("no Markdown");
    await writeFile(join(cwd, "file.md"), document());
    await expect(Effect.runPromise(loadPlan("file.md", cwd))).rejects.toThrow(
      "expected a stages directory",
    );
    await expect(Effect.runPromise(loadPlan("missing", cwd))).rejects.toThrow(
      "Could not read stages",
    );
  });
});

test("argv preserves quoted values as one argument and has no shell or persistence flags", () => {
  const stage = parseStage(
    document(
      header
        .replace("medium", "'high\"; x = true #'")
        .replace("mock-model", "'some model; $(touch nope)'"),
    ),
    "safe.md",
  );
  const args = execArgs(stage, "/repo with space/subdir");
  expect(args[args.indexOf("--model") + 1]).toBe(stage.model);
  expect(args[args.indexOf("-c") + 1]).toBe('model_reasoning_effort="high\\"; x = true #"');
  expect(args[args.indexOf("--cd") + 1]).toBe("/repo with space/subdir");
  expect(args.at(-1)).toBe("-");
  expect(args).toContain("--ephemeral");
  expect(args).not.toContain("--full-auto");
  expect(args).not.toContain("--dangerously-bypass-approvals-and-sandbox");
});

describe("stage execution prompt", () => {
  const instructions =
    "After completing the stage, inspect your changes and commit them. Use a short subject describing the outcome. In the body, explain why and show a compact Before → After sketch when useful. Record only checks actually run. Skip empty commits.";

  test.each([
    "Do the work.",
    "Do the work.\n",
    "\n# Prompt\n${not_a_variable}\n---\n```sh\nprintf '%s' $(touch nope)\n```\n",
    "# Windows line endings\r\nPreserve this body.\r\n",
    "# Unicode 🌍\nBefore → After\n日本語\n\n",
  ])("preserves the literal body and appends the exact commit instructions: %j", (body) => {
    const stage = parseStage(document(header, body), "prompt.md");
    const original = stage.prompt;
    const expected = `${body}\n\n${instructions}\n`;
    expect(stagePrompt(stage)).toBe(expected);
    expect(stagePrompt(stage)).toBe(expected);
    expect(stage.prompt).toBe(original);
  });

  test.each([
    { scope: "PR", override: undefined },
    { scope: "commit", override: undefined },
    { scope: "  Arbitrary scope with spaces  ", override: undefined },
    { scope: undefined, override: "Only check parser behavior" },
    { scope: "Stage default", override: "  $(touch nope); ${literal}  " },
  ])(
    "prepends exactly one scope line and preserves the body and commit appendix: %j",
    ({ scope, override }) => {
      const body = "\n# Literal body\r\n${not_a_variable}\n---\nBefore → After 🌍\n";
      const yaml = scope === undefined ? header : `${header}\nscope: ${JSON.stringify(scope)}`;
      const stage = parseStage(document(yaml, body), "scoped-prompt.md");
      const expected = `Scope: ${override ?? scope}\n\n${body}\n\n${instructions}\n`;
      expect(stagePrompt(stage, override)).toBe(expected);
      expect(stagePrompt(stage, override)).toBe(expected);
      expect(stage.prompt).toBe(body);
      expect(stage.scope).toBe(scope);
    },
  );
});

test("line reporter preserves split UTF-8 and flushes partial bounded lines", () => {
  const lines: string[] = [];
  const sink = lineReporter((line) => lines.push(line));
  const data = Buffer.from("héllo 🌍\r\npartial");
  for (const byte of data) sink.data(Buffer.from([byte]));
  sink.end();
  expect(lines).toEqual(["héllo 🌍", "partial"]);
  const long: string[] = [];
  const bounded = lineReporter((line) => long.push(line));
  bounded.data(Buffer.from("x".repeat(20_000)));
  bounded.end();
  expect(long.join("")).toHaveLength(20_000);
  expect(Math.max(...long.map((l) => l.length))).toBeLessThanOrEqual(8_192);
});
