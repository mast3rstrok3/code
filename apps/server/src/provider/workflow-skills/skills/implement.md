---
name: implement
description: "Implement a piece of work based on a spec or set of tickets."
disable-model-invocation: true
---

Implement the work described by the user in the spec or tickets.

Use /tdd where possible, at pre-agreed seams.

Run focused tests and affected type checks as the work changes. Follow the active workflow phase's validation scope. Ticket implementation and ticket repair use focused acceptance checks; the integrated workflow owns full project validation and shared regression repairs. Outside a workflow, follow the repository's completion checks.

Once done, use /code-review to review the work.

Commit your work to the current branch.
