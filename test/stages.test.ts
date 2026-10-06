import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  cleanup,
  commitInstructions,
  events,
  expectFixtureStopped,
  launch,
  stage,
  timeout,
  workspace,
} from "./helpers.ts";

afterEach(cleanup);

const header = "name: Example\nstep: 0\nmodel: mock-model\nreasoning_effort: medium";
const document = (yaml = header, body = "Do the work.\n") => `---\n${yaml}\n---\n${body}`;

const invalidMetadata: [string, string, string][] = [
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
  ["unknown field", `${header}\nunexpected_field: x`, "unexpected_field"],
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
  ["name without letters or numbers", header.replace("Example", '"!!!"'), "name"],
];

describe("stage configuration through the CLI", () => {
  test.each(invalidMetadata.map(([label, yaml, field]) => ({ label, yaml, field })))(
    "rejects $label with file and field context",
    async ({ yaml, field }) => {
      const ws = workspace();
      writeFileSync(join(ws.stages, "bad.md"), document(yaml));
      const result = await launch(ws, ["validate", "stages"]).result;
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("bad.md");
      expect(result.stderr).toContain(field);
      expect(events(ws)).toEqual([]);
    },
    timeout,
  );

  test.each([
    { label: "missing frontmatter", source: "No frontmatter", context: "frontmatter" },
    { label: "leading newline", source: `\n${document()}`, context: "frontmatter" },
    { label: "two leading BOMs", source: `\uFEFF\uFEFF${document()}`, context: "frontmatter" },
    {
      label: "missing opening fence",
      source: document().replace(/---\n/, ""),
      context: "frontmatter",
    },
    { label: "missing closing fence", source: "---\nname: missing close", context: "frontmatter" },
    { label: "blank body", source: document(header, " \r\n\t"), context: "prompt" },
    { label: "NUL in body", source: document(header, "prompt\0"), context: "prompt" },
  ])(
    "rejects $label without starting Codex",
    async ({ source, context }) => {
      const ws = workspace();
      writeFileSync(join(ws.stages, "bad.md"), source);
      const result = await launch(ws).result;
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("bad.md");
      expect(result.stderr).toContain(context);
      expect(events(ws)).toEqual([]);
    },
    timeout,
  );

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
  )(
    "rejects invalid frontmatter scope: %j",
    async ({ scope }) => {
      const ws = workspace();
      writeFileSync(
        join(ws.stages, "invalid-scope.md"),
        document(`${header}\nscope: ${JSON.stringify(scope)}`),
      );
      const result = await launch(ws).result;
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("invalid-scope.md");
      expect(result.stderr).toContain("scope");
      expect(events(ws)).toEqual([]);
    },
    timeout,
  );

  test(
    "trims metadata while accepting BOM, CRLF, comments and YAML block text",
    async () => {
      const ws = workspace();
      const body = "\n# Prompt\r\n${not_a_variable}\r\n---\r\nBefore → After 🌍\r\n";
      writeFileSync(
        join(ws.stages, "windows.md"),
        '\uFEFF---\r\nname: "  Héllo, World!  " # comment\r\nstep: 2\r\nmodel: "  mock-model  "\r\nreasoning_effort: >-\r\n  medium\r\n---\r\n' +
          body,
      );
      const result = await launch(ws, ["run", "stages", "--verbose"]).result;
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("Héllo, World!");
      expect(result.stdout).toContain("Step 2");
      expect(result.stdout).toContain("mock-model");
      expect(result.stdout).toContain("medium");
      const starts = events(ws).filter((event) => event.kind === "start");
      expect(starts).toHaveLength(1);
      expect(starts[0]?.prompt).toBe(`${body}\n\n${commitInstructions}\n`);
      await expectFixtureStopped(ws);
    },
    timeout,
  );

  test.each([
    "PR",
    "commit",
    "Review only the files under src/parser",
    "  Preserve surrounding spaces  ",
    "日本語 🌍: check the Before → After behavior",
    "$(touch nope); `touch nope`; ${literal} | cat > nope",
  ])(
    "delivers arbitrary frontmatter scope literally to Codex: %j",
    async (scope) => {
      const ws = workspace();
      const body = "# Instructions\nKeep this body unchanged.\n";
      stage(ws, "scoped.md", { scope, prompt: body });
      const result = await launch(ws).result;
      expect(result.code).toBe(0);
      const starts = events(ws).filter((event) => event.kind === "start");
      expect(starts).toHaveLength(1);
      expect(starts[0]?.prompt).toBe(`Scope: ${scope}\n\n${body}\n\n${commitInstructions}\n`);
      await expectFixtureStopped(ws);
    },
    timeout,
  );

  test(
    "delivers a plain YAML scope scalar to Codex",
    async () => {
      const ws = workspace();
      writeFileSync(
        join(ws.stages, "plain.md"),
        document(`${header}\nscope: files changed since yesterday`),
      );
      const result = await launch(ws).result;
      expect(result.code).toBe(0);
      const starts = events(ws).filter((event) => event.kind === "start");
      expect(starts).toHaveLength(1);
      expect(starts[0]?.prompt).toBe(
        `Scope: files changed since yesterday\n\nDo the work.\n\n\n${commitInstructions}\n`,
      );
      await expectFixtureStopped(ws);
    },
    timeout,
  );

  test.each([
    "Do the work.",
    "Do the work.\n",
    "\n# Prompt\n${not_a_variable}\n---\n```sh\nprintf '%s' $(touch nope)\n```\n",
    "# Windows line endings\r\nPreserve this body.\r\n",
    "# Unicode 🌍\nBefore → After\n日本語\n\n",
  ])(
    "delivers the exact body and one commit appendix to Codex: %j",
    async (body) => {
      const ws = workspace();
      stage(ws, "prompt.md", { prompt: body });
      const result = await launch(ws).result;
      expect(result.code).toBe(0);
      const starts = events(ws).filter((event) => event.kind === "start");
      expect(starts).toHaveLength(1);
      expect(starts[0]?.prompt).toBe(`${body}\n\n${commitInstructions}\n`);
      await expectFixtureStopped(ws);
    },
    timeout,
  );
});

describe("stage discovery through validate", () => {
  test(
    "accepts a symlink to the supplied stage directory while ignoring broken entries",
    async () => {
      const ws = workspace({ git: false, codex: false });
      stage(ws, "a.md", { name: "Linked root" });
      symlinkSync(ws.stages, join(ws.cwd, "linked-stages"));
      symlinkSync(join(ws.stages, "missing"), join(ws.stages, "broken.md"));
      const result = await launch(ws, ["validate", "linked-stages"]).result;
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("1 stages, 1 layers");
      expect(result.stdout).toContain("Linked root");
      expect(events(ws)).toEqual([]);
    },
    timeout,
  );

  test(
    "discovers nested Markdown, ignores symlinks and other files, and displays numeric layers in filename order",
    async () => {
      const ws = workspace({ git: false, codex: false });
      stage(ws, "z.MD", { name: "Last", step: 20 });
      stage(ws, "b.md", { name: "Second" });
      stage(ws, "a.md", { name: "First" });
      stage(ws, "nested/later.md", { name: "Later", step: 3 });
      writeFileSync(join(ws.stages, "ignored.txt"), "not a stage");
      symlinkSync(join(ws.stages, "a.md"), join(ws.stages, "linked.md"));
      symlinkSync(ws.stages, join(ws.stages, "cycle"));
      // An invalid external stage would make validation fail if this link were followed.
      const outside = join(ws.root, "outside");
      mkdirSync(outside);
      writeFileSync(join(outside, "bad.md"), "not a stage");
      symlinkSync(outside, join(ws.stages, "external"));
      const result = await launch(ws, ["validate", "./stages"]).result;
      expect(result.code).toBe(0);
      expect(result.stdout).toMatch(/4 stages, 3 layers/);
      const tokens = ["Step 0", "First", "Second", "Step 3", "Later", "Step 20", "Last"];
      let previous = -1;
      for (const token of tokens) {
        const index = result.stdout.indexOf(token);
        expect(index).toBeGreaterThan(previous);
        previous = index;
      }
      expect(result.stdout).toContain("wait for all stages");
      expect(result.stdout).toMatch(/concurrent.*shared checkout/);
    },
    timeout,
  );

  test(
    "rejects names that collide after accent, case and punctuation normalization",
    async () => {
      const ws = workspace();
      stage(ws, "a.md", { name: "Hello World" });
      stage(ws, "b.md", { name: "HÉllo-world!", step: 2 });
      const result = await launch(ws).result;
      expect(result.code).toBe(1);
      expect(result.stderr).toContain("a.md");
      expect(result.stderr).toContain("b.md");
      expect(result.stderr).toMatch(/colli/i);
      expect(events(ws)).toEqual([]);
    },
    timeout,
  );

  test(
    "accepts names with non-Latin letters",
    async () => {
      const ws = workspace({ git: false, codex: false });
      stage(ws, "japanese.md", { name: "日本語 名前" });
      const result = await launch(ws, ["validate", "stages"]).result;
      expect(result.code).toBe(0);
      expect(result.stdout).toContain("日本語 名前");
    },
    timeout,
  );

  test(
    "reports every invalid file together with the offending fields",
    async () => {
      const ws = workspace();
      writeFileSync(join(ws.stages, "a.md"), document(header.replace("step: 0", "step: -1")));
      writeFileSync(join(ws.stages, "b.md"), document(`${header}\nunexpected_field: []`));
      const result = await launch(ws).result;
      expect(result.code).toBe(1);
      for (const context of ["a.md", "step", "b.md", "unexpected_field"]) {
        expect(result.stderr).toContain(context);
      }
      expect(events(ws)).toEqual([]);
    },
    timeout,
  );

  test.each([
    { directory: "stages", message: /no Markdown/i },
    { directory: "file.md", message: /expected a stages directory/i },
    { directory: "missing", message: /Could not read stages/i },
  ])(
    "rejects an unusable stage directory: $directory",
    async ({ directory, message }) => {
      const ws = workspace();
      writeFileSync(join(ws.cwd, "file.md"), document());
      const result = await launch(ws, ["run", directory]).result;
      expect(result.code).toBe(1);
      expect(result.stderr).toMatch(message);
      if (directory === "missing") {
        expect(result.stderr).toContain("ENOENT");
        expect(result.stderr).toContain(join(ws.cwd, directory));
      }
      expect(events(ws)).toEqual([]);
    },
    timeout,
  );
});
