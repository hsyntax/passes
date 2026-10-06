---
name: Reduce redundant I/O
step: 4
model: gpt-6.1-sol
reasoning_effort: xhigh
---

Reduce unnecessary external operations while preserving behavior.

1. Inspect scoped code for repeated or unnecessary database queries, API requests, file reads, and subprocess calls.
2. Establish a baseline using operation counts or measurements.
3. Look for opportunities to use Effect `RequestResolver` or batching to combine compatible, independent requests. Remove redundant operations and use genuine bulk APIs where available; do not disguise per-item calls as batching. Bound batch sizes and verify the actual API contract.
4. Use suitable Effect integrations from the vendored `repos/effect` source when they simplify the change.
5. Preserve data freshness, authorization, transactions, ID-to-result association, ordering, duplicates, errors, cancellation, resource cleanup, and intentional concurrency.
6. Verify the improvement and behavior with relevant tests and before/after counts or measurements. Leave the code unchanged if no justified improvement exists.
