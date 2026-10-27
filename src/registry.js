// Single source of truth: which agents exist and what each workflow includes.
export const AGENTS = {
  orchestrator: { title: "Orchestrator", desc: "Manager of the AI team. Routes every task through the right agents and enforces checkpoints." },
  planner:      { title: "Planner", desc: "Inspects the project and writes implementation_plan.md before any code is written." },
  architect:    { title: "Architect", desc: "Decides HOW to build: structure, data flow, API design, trade-offs." },
  nextjs:       { title: "Next.js Developer", desc: "Next.js App/Pages Router: server vs client components, route handlers, server actions, middleware, env safety." },
  frontend:     { title: "Frontend Developer", desc: "React/Next.js UI, state, API integration, responsive design." },
  backend:      { title: "Backend Developer", desc: "Node/Express APIs, auth, validation, business logic, error handling." },
  database:     { title: "Database Specialist", desc: "Schema design, indexes, queries, transactions, data validation." },
  python:       { title: "Python Backend Developer", desc: "FastAPI/Flask/Django APIs, auth dependencies, Pydantic/ORM models, validation." },
  flutter:      { title: "Flutter Developer", desc: "Flutter apps: feature structure, state management, secure storage, API layer." },
  mobile:       { title: "Mobile Developer", desc: "Flutter / React Native screens, state and mobile APIs." },
  microservices:{ title: "Microservices Architect", desc: "Service boundaries, contracts, sync vs async, failure handling, data ownership." },
  docker:       { title: "Docker Specialist", desc: "Dockerfiles, compose, image size, non-root, healthchecks, no secrets in images." },
  aws:          { title: "AWS Cloud Engineer", desc: "AWS: IAM least privilege, no long-lived keys, ECS/Lambda/RDS/S3, secrets, IaC, cost, rollback." },
  azure:        { title: "Azure Cloud Engineer", desc: "Azure: managed identity, Key Vault, Container Apps/App Service/Functions, Cosmos/SQL/Storage, IaC, cost, rollback." },
  devops:       { title: "DevOps Engineer", desc: "Docker, CI/CD, AWS, Nginx, environments, deployment and rollback." },
  "ui-css":     { title: "UI/CSS Expert", desc: "Tailwind, shadcn/ui, design systems, accessibility, responsive layouts." },
  tester:       { title: "Test Engineer", desc: "Writes and improves unit tests, finds untested logic, checks coverage and test quality." },
  qa:           { title: "QA Engineer", desc: "Runs real tests and verifies behavior, edge cases and regressions." },
  security:     { title: "Security Auditor", desc: "JWT, RBAC, injection, XSS, CORS, CSRF, secrets, dependencies." },
  performance:  { title: "Performance Engineer", desc: "API latency, queries, indexes, bundle size, caching, rendering." },
  reviewer:     { title: "Code Reviewer", desc: "Judges quality: architecture, maintainability, duplication, design." },
  docs:         { title: "Documentation Writer", desc: "Keeps README, API docs and architecture docs in sync with code." },
  git:          { title: "Git Agent", desc: "Proposes conventional commits, only after the quality gate passes." }
};

export const SPECIALISTS = ["architect", "microservices", "tester", "frontend", "nextjs", "backend", "database", "python", "mobile", "flutter", "docker", "devops", "aws", "azure", "ui-css", "security", "performance"];

export const WORKFLOWS = {
  minimal:  { label: "Minimal (quick fixes)", core: ["orchestrator", "reviewer"] },
  standard: { label: "Standard (normal features)", core: ["orchestrator", "planner", "reviewer"] },
  full:     { label: "Full Pipeline (production features)", core: ["orchestrator", "planner", "qa", "security", "reviewer", "docs", "git"] }
};

// Output contracts: the report each agent must produce (checked by `agentforge validate`).
export const CONTRACTS = {
  planner:     { file: "implementation_plan.md", headings: ["Goal", "Steps", "Files", "Risks"] },
  architect:   { file: "architecture_decision.md", headings: ["Decision", "Alternatives", "Consequences", "Diagram"], mermaid: true },
  microservices: { file: "service_design.md", headings: ["Services", "Contracts", "Failure Handling", "Diagram"], mermaid: true },
  aws:         { file: "cloud_design_aws.md", headings: ["Services", "Security", "Cost", "Rollback"] },
  azure:       { file: "cloud_design_azure.md", headings: ["Services", "Security", "Cost", "Rollback"] },
  tester:      { file: "test_report.md", headings: ["Commands Run", "Tests Added", "Coverage", "Verdict"] },
  qa:          { file: "qa_report.md", headings: ["Commands Run", "Results", "Verdict"] },
  security:    { file: "security_report.md", headings: ["Findings", "Verdict"] },
  performance: { file: "performance_report.md", headings: ["Findings", "Verdict"] },
  reviewer:    { file: "review_report.md", headings: ["Findings", "Verdict"] }
};
