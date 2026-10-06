---
name: Improve data-access performance
step: 2
model: gpt-6-luna
reasoning_effort: high
---

Eliminate N+1 queries and repeated external requests using batched SQL, batch-capable data-access APIs, and Effect RequestResolver where appropriate. Verify improvements with query/request counts or representative benchmarks.

Preserve authorization and transaction boundaries, result association/order/duplicates, missing-result and error semantics, and cancellation. Bound batch sizes and concurrency; do not batch dependent operations.

Illustrative before/after pseudocode, not a verified executable resolver rewrite:

- Before: query once per ID; after: one parameterized `IN`/`ANY` query per bounded batch, map rows by ID, then restore input order and duplicates.
- Before: a data-access API accepts only `getOne(id)`; after: expose `getMany(ids)` backed by a bulk query, not a loop of single-record queries.
- Before: independent Effect requests each hit the backend; after: `RequestResolver` collects compatible requests and calls the batch API, completing each request with its own result/error.

Use existing functions directly; avoid unnecessary wrappers. Style: use a direct call for one operation; use `pipe` for two or more chained operations, with at most five calls per chain outside generators. Inside generators, combine transformations of the same value before yielding; keep dependent actions separate.

When needed, consult the target repository's vendored `repos/effect` source and pinned version. Check the actual database/driver's parameter-binding and bulk-operation APIs; never interpolate IDs into SQL.

References: [Effect 4.0.0 RequestResolver](https://github.com/Effect-TS/effect/blob/effect@4.0.0/packages/effect/src/RequestResolver.ts), PostgreSQL [IN/ANY](https://www.postgresql.org/docs/current/functions-comparisons.html) and [parameters](https://www.postgresql.org/docs/current/sql-prepare.html). Array `ANY` is PostgreSQL-specific; adapt to the target database.
