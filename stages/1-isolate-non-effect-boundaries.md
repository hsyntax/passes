---
name: Isolate non-Effect boundaries
step: 1
model: gpt-6-luna
reasoning_effort: high
---

Keep core execution in Effect; isolate non-Effect SDK and API boundaries.

- Prefer an existing Effect integration over a custom adapter.
- Otherwise wrap the smallest external operation, preserving errors, interruption, and resource cleanup.
- Cancellation reaches the external operation only when its SDK supports abort and the adapter wires that support; do not imply that wrapping a Promise makes it cancellable.
- Minimize internal `runPromise` calls and nested runtime exits. Retain genuine application entrypoints and required Promise-facing integrations.

Use existing functions directly. Use direct calls for one operation and `pipe` for two to five chained calls outside generators. Inside generators, combine same-value transformations before yielding; keep dependent actions separate.

When needed, consult the target repository's vendored `repos/effect` source, pinned version, and the external SDK's actual error/abort/cleanup contract.
