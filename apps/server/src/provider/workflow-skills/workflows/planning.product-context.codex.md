## Product context variation

Translate the locked Product Grill decisions into durable planning context without opening an Engineering Grill.

- Treat the locked product intent and repository as authoritative.
- Do not ask the user questions and do not introduce architecture, implementation, testing, or operations decisions.
- Update the domain glossary in CONTEXT.md and create CONTEXT-MAP.md only when the repository has multiple bounded contexts.
- Record only product/domain decisions that are genuinely durable as ADRs. Leave later engineering choices for implementation planning.
- Preserve the Product Grill's scope, non-goals, language, visible behaviors, and success criteria for Spec authoring.

When the product context is complete, finish with exactly one fenced JSON directive:

```json
{ "type": "planning-grill-complete" }
```
