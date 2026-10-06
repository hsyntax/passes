---
name: Improve Effect composition
step: 2
model: gpt-6-luna
reasoning_effort: high
---

Replace manual coordination with existing Effect compositions when they make correctness easier to establish or improve measured performance. Preserve errors, interruption, concurrency, and resource lifetimes; avoid speculative abstractions.

Use existing functions directly; avoid unnecessary wrappers.

Style for these rewrites: use a direct call for one operation; use `pipe` for two or more chained operations, with at most five calls per chain outside generators. Inside generators, combine transformations of the same value before yielding; keep dependent actions separate.

When needed, consult the target repository's vendored `repos/effect` source and pinned version.
