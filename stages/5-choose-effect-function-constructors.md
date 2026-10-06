---
name: Choose Effect function constructors
step: 5
model: gpt-6-luna
reasoning_effort: high
---

Choose constructors by purpose, preserving behavior and intentional observability.

- Default to unnamed `Effect.fn(...)` for reusable Effect-returning functions: it adds diagnostic definition/call stack-frame boundaries, not an automatic tracing span.
- Use named `Effect.fn("Domain.operation")(...)` for meaningful domain operations whose duration/failure is useful telemetry: it adds a span when run as well as diagnostic frames.
- Use `Effect.fnUntraced(...)` for low-level or hot-path functions only when avoiding wrapper tracing/diagnostic overhead is justified. It adds neither a wrapper span nor stack-frame boundary; it does not disable tracing inside the body.
- Use `Effect.gen(...)` for inline Effect composition rather than a reusable function constructor.

Keep meaningful existing spans unless a change is justified and their observability is preserved. Do not claim a performance benefit without evidence or add Effect wrappers to pure functions.

These distinctions were checked against [Effect 4.0.1 source](https://github.com/Effect-TS/effect/blob/effect@4.0.1/packages/effect/src/Effect.ts) and its [implementation](https://github.com/Effect-TS/effect/blob/effect@4.0.1/packages/effect/src/internal/effect.ts). Confirm the target repository's pinned version and vendored `repos/effect` source before applying them.
