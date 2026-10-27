## Active workflow: FULL PIPELINE
Use for important production features.

Planner -> [Architect] -> Specialists -> QA -> Security -> [Performance] -> Reviewer -> QUALITY GATE -> Docs -> Git

- Every arrow is a checkpoint: show a summary and wait for Continue / Redo / Stop.
- `agentforge checkpoint` before development; `agentforge gate --strict` before Docs.
- If QA, Security or Review returns FAIL / CHANGES REQUESTED, send work back to the owning developer agent, then re-run QA.
- Docs and Git run only when the gate prints READY.
- Git proposes the commit; the user performs or approves it.
