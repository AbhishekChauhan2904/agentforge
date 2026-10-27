# agentforge

Turn **Cursor**, **OpenCode** or **Gemini CLI** into a structured AI engineering team:
Plan -> Architect -> Develop -> QA -> Security -> Review -> Quality Gate -> Docs -> Git,
with human approval checkpoints at every step.

It does not build your app. It builds the **AI workflow around your app**, and adds real engineering controls that prompt-only frameworks lack.

## Quick start

```bash
npm install
npm link                 # makes `agentforge` available globally
cd your-project
agentforge init          # pick tool, workflow, specialists
```

Non-interactive: `agentforge init --yes --tool cursor --workflow full --agents backend,frontend,database`

## What gets generated

| Tool | Output |
|------|--------|
| Cursor | `.cursor/rules/*.mdc` (orchestrator is always-on) |
| OpenCode | `.opencode/agents/*.md` + `opencode.json` |
| Gemini CLI | `GEMINI.md` |
| All | `.ai/` project memory, `.ai/config.json`, `.ai/reports/` |

## Typical flow

```bash
agentforge init                      # once per project
agentforge install-hooks             # commits are blocked if the gate fails
agentforge start "add admin ticket management"
agentforge next                      # tells you what to say to your AI
#   ...agent works, writes .ai/reports/implementation_plan.md...
agentforge approve                   # verifies the report, advances to the next step
agentforge status
```

`approve` refuses to advance until the step's report exists, has its required sections and does not carry a negative verdict; the gate step runs the real tests, lint, build, audit and secret scan. The workflow is enforced by code, not only by prompts. `--force` overrides and is recorded.

## Commands

| Command | Purpose |
|---------|---------|
| `init` / `update` / `uninstall` | Install, refresh or remove agent files. `update` and `uninstall` never touch prompts you edited |
| `start "task"` / `next` / `approve` / `status` | Run a task through the pipeline |
| `gate [--strict]` | Tests, lint, type-check, build, `npm audit`, secret scan (+ report validation) |
| `validate [agent]` | Check agent reports against their contracts |
| `checkpoint [label]` | Snapshot the whole working tree (including new files) without touching your index or branch |
| `rollback [tag] [--dry-run] [--yes] [--force]` | Restore a checkpoint; lists exactly what changes first |
| `install-hooks` / `uninstall-hooks` | Git pre-commit hook running the gate |
| `tests` / `metrics` / `design` | Unit-test health and coverage; lines of code, complexity and nesting; coupling, god files and the data-model diagram (`.ai/*.md`) |
| `adr "title"` | Create a numbered Architecture Decision Record in `docs/adr/` |
| `language [ts\|js]` | Show or switch the TypeScript / JavaScript rules the agents follow |
| `cloud` / `cloud init aws\|azure` | AWS/Azure usage and IaC/CI security findings (`.ai/cloud.md`); scaffold a secure OIDC deploy workflow |
| `api` / `db` / `structure` / `audit` | Static API security map, database safety checks, layering and Flutter structure checks (reports in `.ai/*.md`) |
| `graph [--print]` | Draw the project as Mermaid diagrams (`.ai/graph.md`): services, databases, calls, folder dependencies, cycles |
| `services` | List detected services (api / frontend / worker) and the databases they need |
| `docker init` / `docker check` | Scaffold Dockerfile + compose with secure defaults; lint them (secrets block the gate) |
| `analyze`, `doctor [--prompts]`, `stats` | Refresh context, check setup / lint prompts, gate history |

## Unit tests, code metrics and software design

```bash
agentforge tests      # which logic files have tests, test quality, coverage     -> .ai/tests.md
agentforge metrics    # lines of code, complexity, nesting, test:source ratio    -> .ai/metrics.md
agentforge design     # coupling, god files, cycles, ER data-model diagram       -> .ai/design.md
agentforge adr "Use PostgreSQL instead of MongoDB"                              -> docs/adr/0001-....md
```

| Check | Blocks the gate | Warns |
|-------|-----------------|-------|
| **Test health** | committed `.only` / `fit` / `solo`; line coverage below `minCoverage` (if you set it) | no tests at all, tests with no assertions, empty or skipped tests, large untested files, no test script |
| **Code metrics** | function over 150 lines or complexity over 30 | function over 60 lines, complexity over 15, nesting over 4, file over 400 lines, little test code |
| **Software design** | circular dependencies | module with too many dependencies, a stable module depending on an unstable one, god files, high fan-out |

Both are on by default for new projects (`testCheck`, `metricsCheck`); change the limits with `"limits": { "functionLines": 40, "complexity": 10 }` and require coverage with `"minCoverage": 80` in `.ai/config.json`. The **Test Engineer** agent reads `.ai/tests.md` and writes tests for the untested files; the **Architect** works from `.ai/design.md` and records decisions with `agentforge adr`; the **Reviewer** checks design and metrics.

**Upgrading an older project:** run `agentforge update`. It refreshes prompts you never edited, keeps the ones you did, and adds the missing config keys (new checks, language) without changing anything you set.

## TypeScript, JavaScript and Next.js

```bash
agentforge init                          # asks: TypeScript or JavaScript (pre-selected from tsconfig), then the agents
agentforge init --yes --language ts --agents nextjs,docker
agentforge language js                   # switch later; agent files are regenerated, your edits are kept
```

| | TypeScript | JavaScript |
|---|---|---|
| **Rules the agents follow** | strict mode, `unknown` instead of `any`, no `@ts-ignore`, zod at every boundary, run `tsc --noEmit` | JSDoc types, `// @ts-check` on sensitive files, runtime validation, do not convert to TS unless asked |
| **Checks** | `strict` off, `@ts-ignore`, more than 10 `any`, stray `.js` files, type check in the gate | n/a (language rules only) |

The **Next.js Developer** agent covers server vs client components, route handlers, server actions, middleware and env safety. `agentforge api` lists every App Router handler, `pages/api` route and server action, and works out which ones `middleware.ts` really protects:

```
| POST   | `/api/tickets`                | yes | NO | yes | NO |
| DELETE | `/api/tickets/:id`            | NO  | NO | NO  | NO |   error: changes data without authentication
| ACTION | `action:ticket.deleteTicket`  | NO  | NO | NO  | NO |   error: server actions are public endpoints
```

It also flags secrets in `NEXT_PUBLIC_` variables, server-only imports in `'use client'` files, auth cookies without `httpOnly`, and `dangerouslySetInnerHTML` without a sanitizer. `@/` path aliases from `tsconfig.json` are resolved, so the graph and layering checks see aliased imports.

## AWS and Azure

```bash
agentforge cloud                 # what you use + what is dangerous (.ai/cloud.md)
agentforge docker init           # a container image to deploy
agentforge cloud init aws        # or: azure. GitHub Actions + OIDC, no stored keys
```

| Area | What is checked |
|------|-----------------|
| **Identity** | Hardcoded AWS keys, Azure account keys / SAS / client secrets, long-lived keys in CI (use OIDC), `Action *` on `Resource *`, `Principal *` |
| **Network** | SSH, RDP, MySQL, Postgres, Mongo, Redis ... open to `0.0.0.0/0` in security groups, CloudFormation and Azure NSGs; SQL firewall open to every IP |
| **Data** | Public S3 ACLs, public access block off, public or unencrypted databases, backups off, storage without HTTPS or with TLS < 1.2, public blobs |
| **Secrets** | Passwords in Terraform/Bicep, unmarked Bicep secrets, plaintext secrets in Lambda/serverless env, committed `terraform.tfstate` and secret `*.tfvars` |

`init` enables the gate item **Cloud Security** when it finds AWS/Azure usage (`cloudCheck` in `.ai/config.json`); only errors block. The **AWS** and **Azure** agents write a design report (services, security, cost, rollback) and are told never to run `terraform apply`, `aws ... delete`, `az group delete` or similar without showing the plan and getting approval. The graph shows which cloud services each service talks to.

The scaffolded workflow runs your tests, builds the image, pushes it to ECR/ACR and updates ECS/Container Apps. Follow `infra/aws/README.md` or `infra/azure/README.md` first: you must create the registry, the OIDC role/credential and the runtime yourself.

## API, database and structure checks

```bash
agentforge audit        # api + db + structure; exit code 1 if any error
agentforge api          # .ai/api-map.md: every endpoint with Auth / Roles / Validation / Rate limit
agentforge db           # .ai/db-map.md: models, schema and query-safety findings
agentforge structure    # .ai/structure.md: layering + Flutter structure
```

| Area | What is checked |
|------|-----------------|
| **Authentication** | Every route: is `authenticate`/`Depends(get_current_user)`/`@jwt_required`/DRF `IsAuthenticated` applied (directly, on the router, or at the mount)? Data-changing route without auth = **error** |
| **Authorization** | Role/permission middleware on admin routes; routes acting on a record by id without an ownership/role check (possible IDOR) |
| **Middleware** | Validation, rate limiting on login/reset, helmet, CORS, central error handling folder |
| **Controllers / routes** | routes -> controllers -> services -> models; upward imports are errors; logic inside route files is flagged |
| **Database** | Password `select:false`, unique email, enums, timestamps, FK indexes, NoSQL/SQL injection, mass assignment |
| **Python** | FastAPI, Flask, Django REST routes + SQLAlchemy/Django models; Python Docker scaffold |
| **Flutter** | One state-management approach, features/data layout, data must not import UI, tokens in secure storage, https only, no hardcoded keys |

`init` turns the gate checks on when it finds a backend or mobile app (`apiCheck`, `dbCheck`, `structureCheck` in `.ai/config.json`); only **errors** block the gate. The **Python** and **Flutter** agents and the updated **Backend** agent are told to run these commands and fix every error.

## Project graph

```bash
agentforge graph          # writes .ai/graph.md (also done by init / analyze)
```

`.ai/graph.md` contains Mermaid diagrams that render on GitHub, in VS Code's Markdown preview and at mermaid.live:

- **System view:** services, databases/brokers, `user -> frontend`, and service-to-service calls.
- **Module view (per service):** `routes -> controllers -> models` style folder dependencies with import counts.
- **Circular dependencies:** listed and drawn in red. Add `"graphCheck": true` to `.ai/config.json` to make cycles block the quality gate.
- **Language breakdown** of the repository.

Agents read the graph before planning, and the Architect/Microservices reports must contain their own Mermaid diagram of the *designed* system (checked by `validate` / `approve`).

**Which language is best?** The tool does not pick one for you. The Architect agent defaults to your existing stack and may recommend another only when a concrete requirement forces it, comparing options against fixed criteria (team skills, ecosystem, performance, concurrency, ops cost, hiring, integration).

## Docker and microservices

```bash
agentforge services          # client (frontend), server (api, needs mongo)
agentforge docker init       # Dockerfile + .dockerignore per service, docker-compose.yml with mongo/redis/postgres as needed
agentforge docker check      # lint; runs without a Docker daemon
```

Scaffolds use pinned images, multi-stage builds, non-root users and healthchecks, and pass `docker check` with zero warnings. Add the **Microservices Architect** only when you really have (or need) several services; the prompt tells it to prefer a modular monolith when a split is not justified. The **Docker Specialist** handles the container; **DevOps** handles CI/CD and cloud.

## Honest limitations

- **Tests, metrics and design are static analysis.** `tests` reports *file-level* coverage (a test imports the file or is named after it), not line coverage; real line coverage is read from a coverage report your test run produced, so run `npm test -- --coverage` first. Complexity is approximate (it counts `if`, loops, `case`, `catch`, `&&`, `||`, `??`, ternaries). Function-level metrics cover JavaScript, TypeScript and Python; Dart is measured per file. Module stability and the ER diagram come from import statements and model definitions, so dynamic imports and unusual ORM styles can be missed.
- Logic files exclude routes, models, components and pages on purpose (they are wiring, schemas and UI); test those with integration or component tests, which `agentforge tests` does not judge.

- **Next.js:** routes, server actions and the middleware matcher are found by pattern matching, not by running the app or using the TypeScript compiler. Auth is recognised by common names (`auth()`, `getServerSession`, `getToken`, Clerk, Supabase, `jwtVerify`, `withAuth`); a custom helper with another name will show as "NO". Only literal matchers in `middleware.ts` are understood. tRPC, GraphQL and routes built dynamically are not parsed. It was tested on realistic sample projects, not yet on large real-world apps.
- The JavaScript option changes the rules the agents follow; it never converts or rewrites your code.

- **Cloud: agentforge never connects to your AWS or Azure account.** It cannot see what is really deployed, what a live security group allows, or what anything costs. It reads files in your repo. Terraform, CloudFormation and Bicep are matched with regular expressions (not a real parser), so modules, variables and generated templates can hide problems. For depth also run `tfsec`/`checkov`, `cfn-lint`, `az bicep build`, and AWS Config / Defender for Cloud.
- The scaffolded deploy workflows were checked for valid YAML/JSON and for passing agentforge's own checks, but **not run against a real AWS or Azure account**. Treat them as a starting point and test in a non-production account first. Only GitHub Actions, ECS Fargate and Azure Container Apps are templated; Lambda, App Service, AKS, EKS and Functions are checked but not scaffolded.

- **API/DB/structure checks are static heuristics, not a pentest.** They read code; they do not send requests. Parsed: Express (including `router.route()` chains and mounted routers), FastAPI, Flask, Django REST classes. **Not parsed:** NestJS decorators, Fastify/Koa routes, Django `urls.py` wiring, GraphQL. Auth applied through an unusual helper name can show as "NO": verify before fixing. The IDOR check only sees the handler's own function body.
- "No index" findings come from the schema files, not the live database. Run `explain` on real queries.

- **Graph:** the module view follows relative `import`/`require` in JS/TS only. Path aliases (`@/...`, tsconfig `paths`), Python, Go and other languages are not traced, and service-to-service links are found only when a URL or `<NAME>_URL`-style variable names the other service. Dotted arrows are inferences. Treat the graph as a fast, mostly-right map, not proof.

- `docker check` is static analysis (regex on Dockerfile/compose). It does not build images or replace `hadolint`/`docker scout`. The scaffold assumes a Node service listening on port 3000 with a `/health` route; adjust it for your app.
- Service detection looks one level down (and under `services/`, `apps/`, `packages/`) for `package.json`; non-Node services are not detected yet.

- Only **OpenCode** has real subagents. In **Cursor** the Orchestrator is an always-on rule and in **Gemini CLI** all roles live in one `GEMINI.md`; the model follows the process voluntarily. That is why `approve`, the gate and the pre-commit hook exist: they enforce the process in code.
- Report validation checks structure (sections, length, verdict), not whether a report is truthful. Treat QA/security reports as claims; the gate is the proof.
- The secret scanner is regex-based: expect some false positives and misses. Use `gitleaks` in CI for depth.
- `rollback` ends with `git reset -q` (unstages everything; file contents are untouched).
- Gate commands for Node, Python, Go and Flutter are auto-detected. Edit `.ai/config.json` for anything else.

## Develop / test

```bash
npm test
```

## Add your own agent

1. Create `templates/agents/<name>.md` (Role / Rules / Output / STOP).
2. Register it in `src/registry.js` (`AGENTS`, optionally `SPECIALISTS` and `CONTRACTS`).

## Roadmap ideas

- Pre-commit hook that runs `agentforge gate`
- `agentforge doctor` to lint your agent prompts
- Python / Go gate presets
- GitHub Action that runs the gate on PRs
