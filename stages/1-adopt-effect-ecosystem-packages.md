---
name: Adopt Effect ecosystem packages
step: 1
model: gpt-6.1-sol
reasoning_effort: high
---

Adopt Effect ecosystem packages that simplify implementation and reduce maintained code.

1. Inspect the requested scope, runtime, and pinned dependencies. Identify custom code or dependencies that Effect integrations could replace.
2. Search the full vendored `repos/effect` package tree: manifests, source, docs, and examples. Look beyond core/platform and installed packages; consult authoritative sources when needed.
3. Verify candidate APIs and version compatibility. Select replacements that simplify the complete implementation, including setup, layers, errors, and tests.
4. Add compatible dependencies and use their APIs directly.
5. Remove superseded code and unused dependencies. Keep changes within scope, avoid unrelated upgrades, and preserve errors, data contracts, filesystem/symlink behavior, ordering, concurrency, interruption, and cleanup.
6. Run relevant tests, typechecking, and builds. Fix regressions without weakening tests.
