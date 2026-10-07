---
name: Apply Effect modules
step: 3
model: gpt-6.1-sol
reasoning_effort: high
---

Apply existing Effect functions, modules, and compositions where they simplify the implementation, make correctness easier to establish, or improve measured performance. Preserve observable behavior, including errors, interruption, concurrency, and resource lifetimes.

- Use existing functions directly; avoid unnecessary wrappers or aliases.
- Build on suitable Effect packages and services already adopted; do not replace them with custom adapters or wrappers around lower-level APIs.
- Avoid hoisting a method used only once when a direct module call is clearer.
- Avoid premature abstractions; do not introduce a deduplication helper before a third clear repetition.
- Remove abstractions whose indirection costs more readability than the duplication they save.

Style for these rewrites: use a direct call for one operation; use `pipe` for two or more chained operations, with at most five calls per chain outside generators. Inside generators, combine transformations of the same value before yielding; keep dependent actions separate.

When needed, consult the target repository's vendored `repos/effect` source and pinned version.
