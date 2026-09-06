## T3 workflow adapter

T3 replaces the upstream issue-tracker storage operations while preserving the map and ticket semantics:

- The durable Wayfinder Map is stored in the Planning side panel above Spec, not as an issue.
- Decision tickets use T3 Planning Tickets. The map id is their specId, and native ticket dependencies represent blocking edges.
- Use the Engineering Grill wherever the upstream text invokes /grilling plus /domain-modeling.
- Load the canonical map with workflow_wayfinder_map_get. Leave research as durable tickets for the ticket scheduler and keep map work in this thread.
- A map write ends with one wayfinder-map-artifact JSON directive containing title and summaryMarkdown. A decision-ticket write uses planning-tickets-artifact with the map id as specId.

The ticket scheduler owns research concurrency. Leave research as durable tickets instead of starting background agents from the map thread.

These storage and handoff mappings override only the upstream tracker-specific mechanics; its destination, map, frontier, fog, ticket-type, claiming, one-ticket-per-session, and resolution rules remain authoritative.
