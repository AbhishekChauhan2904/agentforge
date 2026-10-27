# Changelog

## 1.8.0
- **Unit-test health (`agentforge tests`)**: finds which logic files (controllers, services, utils, hooks, actions, middleware, API routes, Python modules, Flutter data/state layers) have a test, ranked by size with the functions to cover (`.ai/tests.md`); flags committed `.only`/`fit`/`solo` (error), tests with no assertions, empty tests and skipped tests; reads real line coverage from `lcov.info`, `coverage-summary.json` or `coverage.xml`; `minCoverage` in `.ai/config.json` makes low coverage block the gate; recommends a runner when none exists. Supports Jest, Vitest, Mocha, node:test, pytest and flutter_test.
- **Lines of code and complexity (`agentforge metrics`)**: source, test and comment LOC per service and language, test-to-source ratio, and per-function length, cyclomatic complexity and nesting depth for JavaScript, TypeScript and Python. Soft limits warn; hard limits (2.5x function length, 2x complexity) block the gate. Tune with `"limits"` in `.ai/config.json`.
- **Software design health (`agentforge design`)**: coupling (afferent/efferent) and stability per module, stable-dependencies violations, god files, high fan-out and fan-in, circular dependencies, plus an **ER data-model diagram** drawn from Mongoose, Prisma, SQLAlchemy and Django models (`.ai/design.md`).
- **`agentforge adr "title"`** creates a numbered Architecture Decision Record in `docs/adr/` and logs it in `.ai/decisions.md`.
- **New Test Engineer agent** (writes tests for what `agentforge tests` found; report validated by `approve`). The Architect prompt now includes software-design principles and low-level-design guidance (data model, sequence diagram); the Reviewer checks design and metrics; QA runs `agentforge tests`.
- **`agentforge update` upgrades older projects**: it adds only the config keys that are missing (new checks, language) and never changes anything you set. Projects from any earlier version keep working; a config from the very first release is covered by tests.
- The gate now reports a crashing check as `SKIP` with the error instead of failing: a bug in a checker can never block your commit.
- Fixed while testing: the test scanner crashed on a file containing `module.exports = {};`; `jwt.verify`/`jwt.decode` with a literal secret was not flagged (only `jwt.sign`); empty files counted as untested logic. A mutation test now breaks a clean MERN project six ways and checks the gate catches each.

## 1.6.0
- **Language option: TypeScript or JavaScript.** `init` asks (pre-selected from your tsconfig), `--language ts|js` for scripts, `agentforge language [ts|js]` shows or switches it later and regenerates the agent files (edited prompts are kept). The choice is stored in `.ai/config.json` and appends language rules to the Frontend, Backend, Next.js and Reviewer agents (strict types, `unknown` over `any`, runtime validation with zod; or JSDoc + `// @ts-check` for JavaScript).
- **New Next.js Developer agent** and Next.js support in the checks:
  - `agentforge api` reads App Router route handlers (dynamic segments, route groups, `export const { GET, POST } = handlers`), Pages Router `pages/api`, **server actions** (public POST endpoints) and `middleware.ts` / `proxy.ts` (it works out which paths the matcher actually protects, including negative-lookahead matchers).
  - Next-specific findings: secrets in `NEXT_PUBLIC_` variables, server-only modules (`@prisma/client`, `fs`, `mongoose`...) imported in `'use client'` components, server env vars read in client components, `dangerouslySetInnerHTML` without a sanitizer, auth cookies without `httpOnly`, missing security headers (info), server actions that act on a record by id with no ownership check, unvalidated `await req.json()` written to the database.
  - `agentforge structure` knows the Next layout: missing root layout, route handlers imported directly, lower layers importing UI, circular dependencies.
  - `agentforge docker init` generates a standalone-output Dockerfile for Next.js and warns if `next.config` lacks `output: "standalone"`.
- **TypeScript checks** (any Node service with a tsconfig): `strict` off, `@ts-ignore`/`@ts-nocheck`, more than 10 uses of `any`, leftover JavaScript files. `doctor` warns when the config says TypeScript but the gate has no type check.
- **Graph resolves tsconfig/jsconfig path aliases** (`@/lib/db`), JSONC comments and trailing commas included, and splits `app/` and `pages/` by section. Previously aliased imports were invisible.
- Fixed while testing: a server action path like `action:ticket.create` looked like a `:param` route and caused false IDOR warnings; two assertions in older tests could never fail and now check real behavior.

## 1.5.0
- **AWS and Azure support.** `agentforge cloud` detects the providers and services your code uses (AWS SDK v2/v3, boto3, `@azure/*`, `azure-*`), plus Terraform, CloudFormation/SAM, Serverless, Bicep, ARM, CDK and CI files, and writes `.ai/cloud.md`.
- **Cloud security checks** (gate item "Cloud Security", enabled by `init` when cloud usage is detected): SSH/RDP/database ports open to `0.0.0.0/0` (rules are judged per block, egress ignored), all-traffic rules, public S3 ACLs and disabled public-access blocks, `Action *` on `Resource *`, `Principal *`, public or unencrypted databases, backups off, Azure storage without HTTPS / with old TLS / public blobs, SQL firewall open to all IPs, App Service without HTTPS-only, NSG rules, hardcoded passwords and unmarked Bicep secrets, plaintext secrets in Lambda/serverless env, committed Terraform state or tfvars, hardcoded AWS/Azure credentials, storage account keys, SAS tokens and client secrets in code, long-lived keys in CI (info). The secret scanner now also knows AWS secret keys, Azure account keys and SAS tokens.
- **`agentforge cloud init aws|azure`**: scaffolds a GitHub Actions deploy workflow that uses OIDC (no stored keys) after running tests, plus an ECS task definition and least-privilege IAM policy templates (AWS) or a federated credential template (Azure), each with a setup README. Never overwrites; templates use `<PLACEHOLDERS>`.
- New agents **AWS Cloud Engineer** and **Azure Cloud Engineer** (least privilege, no long-lived keys, secrets stores, private networking, encryption, cost, rollback, never apply/destroy without approval). Each writes a design report that `approve` validates.
- The project graph now draws the cloud services each service uses; the Architect and DevOps agents read `.ai/cloud.md`.
- Fixed while testing: network rules were matched across neighbouring blocks; IAM wildcard checks looked at the neighbouring policy; Bicep `@secure()` detection picked up a decorator from another parameter.

## 1.4.0
- **`agentforge api`**: lists every endpoint (Express, FastAPI, Flask, Django REST) with auth / roles / validation / rate-limit status. Resolves router mounts and prefixes (`app.use('/api/x', auth, router)`, `include_router(..., dependencies=[...])`, blueprints). Flags unauthenticated data-changing routes (error), public reads, admin routes without role checks, missing rate limiting on login/reset, missing validation, possible IDOR (record by id without ownership check), hardcoded JWT/secret keys, wide-open CORS, debug mode, disabled TLS verification, missing helmet.
- **`agentforge db`**: Mongoose, Prisma, SQLAlchemy and Django models; flags password without `select:false`, non-unique email, role without enum, missing timestamps, unindexed foreign keys, NoSQL injection (`find(req.body)`), `$where`, SQL built by string concatenation/f-strings, mass assignment.
- **`agentforge structure`**: enforces routes -> controllers -> services -> models layering (upward imports are errors), fat routes, missing middleware folder, circular dependencies, files over 400 lines. Flutter: state-management count, feature/data layout, data importing UI, tokens in SharedPreferences, cleartext http, disabled certificate checks, hardcoded keys.
- `agentforge audit` runs all three. Gate checks `API Security`, `DB Safety`, `Code Structure` (enabled by `init` when a backend/mobile app is detected; errors block, warnings do not; disable per check in `.ai/config.json`).
- New agents: **Python Backend Developer** and **Flutter Developer**. Backend prompt now spells out routes/controllers/services/models and `middleware/` (authenticate, authorize, validate, rateLimit, error handler).
- Python and Flutter services are detected, shown in the graph, get module-dependency graphs, and Python gets a Dockerfile scaffold.
- Fixed while testing: JS regex `\Z` bug (only some Python classes were parsed); function-body extraction ran into the next function (hid IDOR findings); Flutter layering rule could not see UI folders inside features.

## 1.3.0
- `agentforge graph`: writes `.ai/graph.md` with Mermaid diagrams built from the real code: a **system view** (services, databases and brokers from dependencies, service-to-service calls from URLs/env vars, docker-compose `depends_on`) and a **module view** per service (folder-level import graph with counts).
- **Circular dependency detection** between folders, highlighted in red. Opt-in gate check: `"graphCheck": true` in `.ai/config.json`.
- Language breakdown table in the graph file.
- `init` and `analyze` generate the graph; Planner, Architect, Microservices and Orchestrator now read it.
- Architect and Microservices reports must include a Mermaid diagram (enforced by `validate`/`approve`).
- Architect prompt: rules for choosing a language/framework (default to the existing stack, compare options against criteria, never switch for a small feature).
- Broker detection (RabbitMQ, Kafka, Redis queues) for the graph and compose scaffold.

## 1.2.0
- New agents: **Microservices Architect** (service boundaries, contracts, failure handling, data ownership) and **Docker Specialist**.
- Service detection (`agentforge services`): finds api / frontend / worker units and the databases they need; written to `.ai/project-context.md`.
- Docker helper CLI: `docker init` scaffolds Dockerfile, `.dockerignore` and docker-compose.yml (secure defaults, never overwrites); `docker check` lints them with no Docker daemon needed.
- Quality gate now includes **Docker Lint**: hardcoded secrets in `ENV`/`ARG` or a copied `.env` block the gate; other findings are warnings. Disable with `"dockerLint": false`.
- New output contract: `service_design.md`.

## 1.1.0
- Workflow enforced by code: `start`, `next`, `approve`, `status` (`.ai/state.json`).
- Rollback rewritten: snapshots untracked files, `--dry-run`, deletes only files created after the checkpoint, never touches ignored or agent files, refuses stale checkpoints.
- `install-hooks`: git pre-commit hook that blocks commits when the gate fails.
- `update` / `uninstall` that never overwrite prompts you edited (hash manifest).
- `doctor` (setup check + prompt linter), config schema validation, `stats` (gate history).
- Python, Go and Flutter gate presets.
- Fixed: reviewer verdict "CHANGES REQUESTED" was not treated as negative.
- Fixed: Standard workflow prompt and code disagreed on gate order (gate is the final check).

## 1.0.0
- Initial release: 15 agents, 3 workflows, quality gate, analyzer, project memory, output contracts, secret scanner.
