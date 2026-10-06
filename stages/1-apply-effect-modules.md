---
name: Apply existing Effect modules
step: 1
model: gpt-6-luna
reasoning_effort: xhigh
---

Apply existing Effect functions and modules where they simplify the implementation while preserving behavior.

- Use existing functions directly; avoid unnecessary wrappers or aliases.
- Avoid hoisting a method used only once when a direct module call is clearer.
- Avoid premature abstractions; do not introduce a deduplication helper before a third clear repetition.
- Remove abstractions whose indirection costs more readability than the duplication they save.

Style for these rewrites: use a direct call for one operation; use `pipe` for two or more chained operations, with at most five calls per chain outside generators. Inside generators, combine transformations of the same value before yielding; keep dependent actions separate.

When needed, consult the target repository's vendored `repos/effect` source and pinned version.
