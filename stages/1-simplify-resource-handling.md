---
name: Effect modules where possible
step: 1
model: gpt-6-luna
reasoning_effort: high
---

Identify opportunities to make the implementation use pre-existing modules or abstractions from our codebase and from `effect` ( repos/effect ) where possible with the objective of simplifying the implementation and reducing duplication while preserving correctness. Then apply all obvious improvements.

Use existing functions directly; avoid unnecessary wrappers.

Style for these rewrites: use a direct call for one operation; use `pipe` for two or more chained operations, with at most five calls per chain outside generators. Inside generators, combine transformations of the same value before yielding; keep dependent actions separate.

- Before: `batches(items, n)` only forwards arguments; after: `Array.chunksOf(items, n)` directly.

Keep size validation: `Array.chunksOf` normalizes invalid sizes instead of rejecting them.

## Leave alone

If an upload protocol requires `[[]]` for empty input to clear remote data, keep that behavior. `Array.chunksOf([], size)` returns `[]` and would skip the required request.

When needed, consult the target repository's vendored `repos/effect` source and pinned version. This adapted example was checked against [Effect 4.0.0 Array source](https://github.com/Effect-TS/effect/blob/effect@4.0.0/packages/effect/src/Array.ts); it is not an upstream before/after pair.
