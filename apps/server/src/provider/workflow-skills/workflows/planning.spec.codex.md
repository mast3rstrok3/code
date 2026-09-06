# Planning Workflow: Spec

## Domain model maintenance

Maintain the project's domain model as part of Spec authoring. When the Spec resolves terminology, capture it in the CONTEXT.md glossary (format in CONTEXT-FORMAT.md): tight definitions, rejected synonyms under _Avoid_, project-specific domain concepts only, no implementation details. Record an ADR in docs/adr/ (format in ADR-FORMAT.md) only when a decision is hard to reverse, surprising without context, and the result of a real trade-off. Create these files lazily — only when you have something to write.

## T3 workflow adapter

The Spec is a durable artifact in T3's application state, not a repository file or tracker issue — a deliberate deviation from upstream. Do not write the Spec to the repository, `.scratch/` files, or an external tracker, and ignore `/setup-matt-pocock-skills` and triage labels. Publish the Spec through the planning-spec-artifact directive requested by the stage launch prompt, finishing with exactly one fenced JSON block.

When a Wayfinder Map exists for this workflow, load it with workflow_wayfinder_map_get and treat the map's linked decisions as the conversation context to synthesize from.

The Engineering Grill is Planning's only user-interactive stage. Do not ask the user to confirm seams during Spec authoring. Resolve seams, glossary updates, and ADR updates yourself from the confirmed Engineering Grill, locked Product Grill intent when present, and the codebase.

These rules override upstream tracker publication and interview mechanics; the spec template and synthesis process remain authoritative.
