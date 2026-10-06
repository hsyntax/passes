---
name: Align domain names
step: 6
model: gpt-6.1-sol
reasoning_effort: high
---

Align function, variable, and module names with domain vocabulary already established in repository docs, types, and code.

- Use a consistent term for each concept within its bounded context; preserve distinctions between contexts, states, and units.
- Name functions for domain actions. Replace vague helper/manager/data or mechanism names only when an established domain term is clearer.
- Do not invent vocabulary, impose a glossary, or unify distinct concepts across contexts.
- Update internal references consistently. Preserve externally visible APIs, serialized fields, database names, and service-tag contracts; do not use blind string replacement.

Example, only if the repository already calls the action invoice approval: `handle(data)` → `approveInvoice(invoice)`.
