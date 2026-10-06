---
name: Improve Effect composition
step: 2
model: gpt-6-luna
reasoning_effort: high
---

Replace manual coordination with existing Effect compositions when they make correctness easier to establish or improve measured performance. Preserve errors, interruption, concurrency, and resource lifetimes; avoid speculative abstractions.

Use existing functions directly; avoid unnecessary wrappers.

Style for these rewrites: use a direct call for one operation; use `pipe` for two or more chained operations, with at most five calls per chain outside generators. Inside generators, combine transformations of the same value before yielding; keep dependent actions separate.

## Good rewrite

For a stable `jobs` array and effectful `runJob`:

```ts
// Before
const results = Effect.gen(function* () {
  const values: string[] = [];
  for (const job of jobs) values.push(yield* runJob(job));
  return values;
});

// After: explicit sequential policy, same order and fail-fast behavior.
const results = Effect.forEach(jobs, runJob, { concurrency: 1 });
```

## Leave alone

```ts
// The body depends on a successful header: keep these actions separate.
Effect.gen(function* () {
  yield* writeHeader(session);
  yield* writeBody(session);
});
```

Do not replace these dependent writes with concurrent `Effect.all`.

When needed, consult the target repository's vendored `repos/effect` source and pinned version. This adapted example was checked against [Effect 4.0.0 Effect source](https://github.com/Effect-TS/effect/blob/effect@4.0.0/packages/effect/src/Effect.ts); it is not an upstream before/after pair.
