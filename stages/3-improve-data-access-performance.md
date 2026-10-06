---
name: Improve data-access performance
step: 3
model: gpt-6-luna
reasoning_effort: high
---

Identify and eliminate N+1 queries and repeated external requests using batched database queries and Effect RequestResolver where appropriate. Preserve authorization boundaries, transaction semantics, result ordering, errors, and cancellation. Bound batch sizes and concurrency; avoid batching dependent operations. Verify improvements through query/request counts or representative benchmarks.

## Judgment examples

Good rewrite, only for independent reads with equivalent authorization, snapshot,
and failure semantics (illustrative pseudocode):

```text
Before: for each ID, query one user under the same tenant/transaction context
After:  split IDs into bounded batches; query each batch in that same context
        index rows by ID; restore input order and duplicates
        preserve the existing missing-user result/error for each requested ID
```

For input `[7, 3, 7]`, rows returned as `[3, 7]` must still produce results in
`[7, 3, 7]` order. Verify the database/request count, not just an unchanged output.
Do not assume a bulk read has the same error or snapshot behavior as single reads.

When requests originate in separate Effect computations, a resolver may collect
them into a batch. In Effect 4.0.0, `RequestResolver.makeGrouped` groups entries by
a key and `RequestResolver.batchN` limits batch size; each entry still needs a
result. Choose keys that preserve the full authorization and transaction context,
and bound execution concurrency separately. Verify the target project's version
and existing resolver conventions before applying these APIs.

Leave alone: a loop where each query depends on the previous write's result, or
reads cross tenant/transaction boundaries that cannot safely share a batch. Also
leave a single cheap request alone when batching adds latency or complexity with
no measured benefit.

The rewrite sketch is adapted guidance, not an upstream before/after example.
API references: Effect 4.0.0
[RequestResolver source](https://github.com/Effect-TS/effect/blob/effect@4.0.0/packages/effect/src/RequestResolver.ts).
