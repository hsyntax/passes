---
name: Improve Effect composition
step: 2
model: gpt-6-luna
reasoning_effort: high
---

Rewrite manual coordination using compositions of existing Effect modules where they make correctness easier to establish or improve measured performance. Preserve observable behavior, including errors, interruption, concurrency, and resource lifetimes. Apply only changes with a concrete benefit; avoid speculative abstractions.

## Examples

### GOOD: express sequential traversal without a mutable result collector

Here `jobs` is a stable array and `runJob` returns an Effect producing a string.

```ts
import { Effect } from "effect";

// Before
const results = Effect.gen(function* () {
  const values: string[] = [];
  for (const job of jobs) {
    values.push(yield* runJob(job));
  }
  return values;
});

// After
const results = Effect.forEach(jobs, (job) => runJob(job), { concurrency: 1 });
```

This removes mutable bookkeeping and makes the sequential execution policy explicit.
It keeps result order and stops on the first failure; it does not introduce new fibers or
change the surrounding scope. Do not claim a performance improvement without measuring it.

### LEAVE ALONE: ordering and resource lifetime are part of the contract

```ts
const write = Effect.scoped(
  Effect.gen(function* () {
    const session = yield* Effect.acquireRelease(connect, disconnect);
    yield* writeHeader(session);
    yield* writeBody(session);
  }),
);
```

If the body must follow a successful header, keep these writes sequential. Replacing them
with `Effect.all([...], { concurrency: "unbounded" })` can start the body before the header
finishes and changes which work is interrupted on failure.

Keep both writes inside the resource scope. This shorter acquisition is not equivalent:

```ts
// Do not move acquisition into a scope that closes before the writes.
const write = Effect.gen(function* () {
  const session = yield* Effect.scoped(Effect.acquireRelease(connect, disconnect));
  yield* writeHeader(session);
  yield* writeBody(session);
});
```

That scope closes and disconnects the session before either write can use it. Fewer lines
are not a benefit when cleanup timing or cancellation behavior changes.

These are adapted examples, not upstream before/after pairs. APIs were checked against
the Effect 4.0.0 [Effect source](https://github.com/Effect-TS/effect/blob/effect@4.0.0/packages/effect/src/Effect.ts)
and [implementation](https://github.com/Effect-TS/effect/blob/effect@4.0.0/packages/effect/src/internal/effect.ts).
Check the target project's pinned version and available source before applying similar rewrites.
