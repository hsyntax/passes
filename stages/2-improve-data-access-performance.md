---
name: Improve data-access performance
step: 2
model: gpt-6-luna
reasoning_effort: high
---

Reduce query/request counts or improve measured performance.

Illustrative before → after sketches, not executable code:

- SQL: one query per ID → one parameterized `IN`/`ANY` bulk query per bounded batch.
- API: only `getOne(id)` → `getMany(ids)` backed by a real bulk operation, not a per-ID loop.
- Effect: one backend call per request → `RequestResolver` groups compatible requests and calls the batch API.

Keep authorization/transaction boundaries, ID-to-result association, order/duplicates, missing-result/error semantics, and cancellation. Bound batch sizes and concurrency; do not batch dependent operations. Verify with counts or benchmarks.

Use existing functions directly. Use direct calls for one operation and `pipe` for two to five chained calls outside generators. Inside generators, combine same-value transformations before yielding; keep dependent actions separate.

Use the target repository's vendored `repos/effect` source and actual database/driver documentation when needed. Match supported bulk-query syntax and bind parameters; never interpolate IDs into SQL.
