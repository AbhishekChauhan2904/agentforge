## Active workflow: STANDARD
Use for normal feature development.

Planner -> (user approval) -> Specialist developers -> (user approval) -> Reviewer -> (user approval) -> QUALITY GATE

- The Planner always runs first and writes `implementation_plan.md`.
- No code is written before the user approves the plan.
- Run `agentforge gate` as the final check after the Reviewer approves. If the gate blocks, send the work back, then review and gate again.
