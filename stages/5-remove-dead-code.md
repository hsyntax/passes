---
name: Remove dead code
step: 5
model: gpt-6.1-sol
reasoning_effort: high
---

Remove code and execution paths that are demonstrably unnecessary.

1. Inspect the requested scope for unused symbols, unreachable branches, obsolete implementations, and redundant paths.
2. Trace candidates across callers, entrypoints, exports, configuration, dynamic registration, and supported platforms. Treat missing references or coverage as clues, not proof.
3. Delete confirmed dead code and simplify redundant paths while preserving supported behavior, public contracts, side effects, errors, concurrency, interruption, and cleanup. Leave uncertain cases unchanged.
4. Remove imports, private helpers, dependencies, and documentation made obsolete by those deletions. Keep edits within scope.
5. Preserve tests for supported behavior; remove tests only when they exclusively cover deleted dead code. Run relevant tests, typechecking, and builds, and fix regressions without weakening coverage.
