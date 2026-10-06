---
name: Improve data-access performance
step: 3
model: gpt-6-luna
reasoning_effort: high
---

Identify and eliminate N+1 queries and repeated external requests using batched database queries and Effect RequestResolver where appropriate. Preserve authorization boundaries, transaction semantics, result ordering, errors, and cancellation. Bound batch sizes and concurrency; avoid batching dependent operations. Verify improvements through query/request counts or representative benchmarks.
