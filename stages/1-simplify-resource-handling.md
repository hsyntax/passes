---
name: Effect modules where possible
step: 1
model: gpt-6-luna
reasoning_effort: high
---

Identify opportunities to make the implementation use pre-existing modules or abstractions from our codebase and from `effect` ( repos/effect ) where possible with the objective of simplifying the implementation and reducing duplication while preserving correctness. Then apply all obvious improvements.

## Examples

### GOOD: replace a duplicate algorithm with an existing module

For ordinary arrays, with `size` already validated as a positive integer:

```ts
// Before
function batches<T>(items: readonly T[], size: number): T[][] {
  const result: T[][] = [];
  for (let i = 0; i < items.length; i += size) {
    result.push(items.slice(i, i + size));
  }
  return result;
}

// After
import { Array } from "effect";

function batches<T>(items: readonly T[], size: number): T[][] {
  return Array.chunksOf(items, size);
}
```

This removes a duplicate chunking algorithm while preserving order, a shorter final batch,
and `[]` for empty input. Preserve the size validation: `Array.chunksOf` normalizes invalid
sizes instead of rejecting them.

### LEAVE ALONE: a wrapper adds required domain behavior

```ts
import { Array } from "effect";

function uploadBatches<T>(items: readonly T[]): T[][] {
  return items.length === 0 ? [[]] : Array.chunksOf(items, 100);
}
```

If the upload protocol requires one empty batch to clear remote data, replacing this wrapper
with `Array.chunksOf(items, 100)` silently skips that request. Keep the domain behavior even
though the helper looks redundant.

These are adapted examples, not upstream before/after pairs. APIs were checked against
the [Effect 4.0.0 Array source](https://github.com/Effect-TS/effect/blob/effect@4.0.0/packages/effect/src/Array.ts).
Check the target project's pinned version and available source before applying similar rewrites.
