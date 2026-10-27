import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { findServices } from "./services.js";

const T = path.join(path.dirname(fileURLToPath(import.meta.url)), "../templates/cloud");
const SKIP = new Set(["node_modules", "dist", "build", "coverage", ".git", ".ai", ".cursor", ".opencode", ".gemini", "venv", ".venv", "__pycache__", ".dart_tool", ".terraform", "vendor", "test", "tests", "__tests__", "fixtures"]);
const TEXT = /\.(m?[jt]sx?|cjs|py|dart|json|ya?ml|tf|tfvars|bicep|bicepparam|sh|ini|cfg|toml|properties|conf|env)$/i;
const read = (p) => { try { return fs.readFileSync(p, "utf8"); } catch { return ""; } };
const lineOf = (t, i) => t.slice(0, i).split("\n").length;

function walk(root, rel = "", out = [], d = 0) {
  let es = []; try { es = fs.readdirSync(path.join(root, rel), { withFileTypes: true }); } catch { return out; }
  for (const e of es) {
    if (SKIP.has(e.name) || (e.name.startsWith(".") && e.name !== ".github" && !/^\.env/.test(e.name))) continue;
    const r = path.join(rel, e.name);
    if (e.isDirectory()) { if (d < 8) walk(root, r, out, d + 1); }
    else if (TEXT.test(e.name) || /^\.env/.test(e.name) || /^(Dockerfile|buildspec|appspec|serverless)/.test(e.name)) out.push(r);
  }
  return out;
}

// ---------- which cloud services does the code use? ----------
const AWS_NAMES = { s3: "S3", dynamodb: "DynamoDB", "lib-dynamodb": "DynamoDB", sqs: "SQS", sns: "SNS", ses: "SES", sesv2: "SES", lambda: "Lambda", "cognito-identity-provider": "Cognito", cognitoidentityserviceprovider: "Cognito", "secrets-manager": "Secrets Manager", secretsmanager: "Secrets Manager", ssm: "SSM Parameter Store", kms: "KMS", cloudwatch: "CloudWatch", "cloudwatch-logs": "CloudWatch", cloudwatchlogs: "CloudWatch", eventbridge: "EventBridge", rds: "RDS", "rds-data": "RDS", kinesis: "Kinesis", sfn: "Step Functions", stepfunctions: "Step Functions", ecs: "ECS", ecr: "ECR", cloudfront: "CloudFront", sts: "STS" };
const AZ_NODE = { "@azure/storage-blob": "Blob Storage", "@azure/storage-queue": "Queue Storage", "@azure/data-tables": "Table Storage", "@azure/cosmos": "Cosmos DB", "@azure/service-bus": "Service Bus", "@azure/event-hubs": "Event Hubs", "@azure/keyvault-secrets": "Key Vault", "@azure/keyvault-keys": "Key Vault", "@azure/keyvault-certificates": "Key Vault", "@azure/identity": "Entra ID / Managed Identity", "@azure/msal-node": "Entra ID", "@azure/functions": "Functions", applicationinsights: "Application Insights", "@azure/communication-email": "Communication Services", "@azure/openai": "Azure OpenAI" };
const AZ_PY = { "azure-storage-blob": "Blob Storage", "azure-storage-queue": "Queue Storage", "azure-data-tables": "Table Storage", "azure-cosmos": "Cosmos DB", "azure-servicebus": "Service Bus", "azure-eventhub": "Event Hubs", "azure-keyvault-secrets": "Key Vault", "azure-keyvault-keys": "Key Vault", "azure-identity": "Entra ID / Managed Identity", "azure-functions": "Functions", "opencensus-ext-azure": "Application Insights", "azure-monitor-opentelemetry": "Application Insights" };
const title = (s) => s.replace(/(^|-)(\w)/g, (_, a, b) => (a ? " " : "") + b.toUpperCase());

export function cloudUsage(cwd, svc) {
  const found = new Map();
  const add = (provider, name) => found.set(`${provider}:${name}`, { provider, name });
  const root = path.join(cwd, svc.dir);
  if (svc.lang === "python") {
    const req = (read(path.join(root, "requirements.txt")) + read(path.join(root, "pyproject.toml"))).toLowerCase();
    if (/\bboto3\b|\bbotocore\b/.test(req)) {
      let any = false;
      for (const f of walk(root).filter((x) => x.endsWith(".py")).slice(0, 300))
        for (const m of read(path.join(root, f)).matchAll(/boto3\.(?:client|resource)\(\s*['"]([\w-]+)['"]/g)) { add("aws", AWS_NAMES[m[1]] || m[1].toUpperCase()); any = true; }
      if (!any) add("aws", "AWS SDK");
    }
    for (const [pkg, name] of Object.entries(AZ_PY)) if (req.includes(pkg)) add("azure", name);
  } else if (svc.lang === "node") {
    for (const dep of Object.keys(svc.deps || {})) {
      const m = dep.match(/^@aws-sdk\/(?:client|lib)-([\w-]+)$/);
      if (m) add("aws", AWS_NAMES[m[1]] || title(m[1]));
      if (AZ_NODE[dep]) add("azure", AZ_NODE[dep]);
    }
    if (svc.deps?.["aws-sdk"]) {
      let any = false;
      for (const f of walk(root).filter((x) => /\.(m?[jt]s|cjs)$/.test(x)).slice(0, 300))
        for (const m of read(path.join(root, f)).matchAll(/new\s+AWS\.(\w+)\(/g)) { add("aws", AWS_NAMES[m[1].toLowerCase()] || m[1]); any = true; }
      if (!any) add("aws", "AWS SDK");
    }
  }
  return [...found.values()];
}

// ---------- kinds of cloud files ----------
function kindOf(rel, text) {
  const base = path.basename(rel);
  if (/\.tf(vars)?$/.test(base)) return "tf";
  if (/\.bicep(param)?$/.test(base)) return "bicep";
  if (/(^|\/)\.github\/workflows\/[^/]+\.ya?ml$/.test(rel)) return "workflow";
  if (/^azure-pipelines\.ya?ml$/.test(base)) return "azpipe";
  if (/^serverless\.ya?ml$/.test(base)) return "serverless";
  if (/^(buildspec|appspec)\.ya?ml$/.test(base) || base === "cdk.json") return "awsci";
  if (/\.(ya?ml|json)$/.test(base)) {
    if (/AWSTemplateFormatVersion|Transform:\s*['"]?AWS::Serverless|(^|\n)\s*Type:\s*['"]?AWS::/.test(text)) return "cfn";
    if (/deploymentTemplate\.json|"type"\s*:\s*"Microsoft\.\w+\/\w+/.test(text)) return "arm";
  }
  return "code";
}

export function detectCloud(cwd) {
  const providers = new Set(), iac = [], deploy = [], services = [];
  for (const svc of findServices(cwd)) for (const u of cloudUsage(cwd, svc)) { providers.add(u.provider); services.push({ ...u, dir: svc.dir }); }
  for (const f of walk(cwd)) {
    const base = path.basename(f), text = base === "package-lock.json" ? "" : read(path.join(cwd, f));
    if (!text && !/^Dockerfile/.test(base)) continue;
    const k = kindOf(f, text);
    if (k === "tf") { iac.push({ kind: "terraform", file: f }); if (/resource\s+"aws_|provider\s+"aws"/.test(text)) providers.add("aws"); if (/resource\s+"azurerm_|provider\s+"azurerm"/.test(text)) providers.add("azure"); }
    else if (k === "bicep" || k === "arm") { iac.push({ kind: k === "bicep" ? "bicep" : "arm", file: f }); providers.add("azure"); }
    else if (k === "cfn") { iac.push({ kind: "cloudformation", file: f }); providers.add("aws"); }
    else if (k === "serverless" || k === "awsci") { iac.push({ kind: k === "awsci" ? "aws-ci/cdk" : "serverless", file: f }); providers.add("aws"); }
    else if (k === "azpipe") { deploy.push(f); providers.add("azure"); }
    else if (k === "workflow") { if (/aws-actions\//.test(text)) { providers.add("aws"); deploy.push(f); } if (/azure\/(login|webapps-deploy|functions-action)/.test(text)) { providers.add("azure"); deploy.push(f); } }
    if (base === "host.json" && /"version"\s*:\s*"2\.0"/.test(text)) { providers.add("azure"); iac.push({ kind: "azure-functions", file: f }); }
    if (base === "staticwebapp.config.json") { providers.add("azure"); iac.push({ kind: "static-web-app", file: f }); }
  }
  return { providers: [...providers].sort(), services, iac, deploy };
}

// ---------- security rules ----------
const SENSITIVE = { 22: "SSH", 3389: "RDP", 3306: "MySQL", 5432: "PostgreSQL", 27017: "MongoDB", 6379: "Redis", 1433: "SQL Server", 9200: "Elasticsearch", 5601: "Kibana", 11211: "Memcached", 2375: "Docker API" };
const exposedPort = (lo, hi) => Object.keys(SENSITIVE).map(Number).find((p) => p >= lo && p <= hi);
const win = (lines, i, before, after) => lines.slice(Math.max(0, i - before), i + after + 1).join("\n");

// The rule block a line belongs to: from the nearest block start up to the next block start.
const BLOCK_START = /^\s*(ingress|egress)\s*\{|^\s*resource\s+"|^resource\s|^\s*-\s+\w+\s*:|^\s*(SecurityGroupIngress|SecurityGroupEgress)\s*:|^\s*\{\s*$/i;
function blockAround(lines, i) {
  let a = i; while (a > 0 && !BLOCK_START.test(lines[a])) a--;
  let b = i + 1; while (b < lines.length && !BLOCK_START.test(lines[b])) b++;
  return lines.slice(a, b).join("\n");
}

function checkOpenNetwork(lines, file, add) {
  lines.forEach((l, i) => {
    if (/(0\.0\.0\.0\/0|::\/0)/.test(l) && !/destination_cidr_block|DestinationCidrBlock/i.test(l)) {
      const block = blockAround(lines, i), before = win(lines, i, 12, 0);
      const dir = [...before.matchAll(/(egress|ingress)/gi)].pop();
      if ((dir && /egress/i.test(dir[1])) || /type\W+["']?egress/i.test(block)) return;
      if (!dir && !/(security|sg|nsg|firewall)/i.test(win(lines, i, 12, 9))) return;
      const from = block.match(/(?:from_?port|FromPort)\W+(\d+)/i), to = block.match(/(?:to_?port|ToPort)\W+(\d+)/i);
      const allProto = /(?:protocol|IpProtocol)\W+["']?(-1|all)\b/i.test(block);
      if (allProto || (from && to && +from[1] === 0 && +to[1] >= 65535) || (from && to && +from[1] === 0 && +to[1] === 0)) return add("error", file, i + 1, "security group allows ALL traffic from the internet (0.0.0.0/0)");
      if (from && to) { const p = exposedPort(+from[1], +to[1]); if (p) return add("error", file, i + 1, `port ${p} (${SENSITIVE[p]}) is open to the internet (0.0.0.0/0): restrict to your IP, a VPN or a security group`); return; }
      add("warn", file, i + 1, "0.0.0.0/0 ingress rule: check which ports are exposed");
    }
    if (/(source_?address_?prefix(?:es)?)\W+(?:\[\s*)?["']?(\*|0\.0\.0\.0\/0|Internet|any)["']?/i.test(l)) {
      const block = blockAround(lines, i);
      if (!/allow/i.test(block) || !/inbound/i.test(block)) return;
      const pr = block.match(/destination_?port_?range\W+["']?([\d*-]+)/i);
      if (!pr) return add("warn", file, i + 1, "NSG rule allows inbound traffic from any source: check the ports");
      if (pr[1] === "*") return add("error", file, i + 1, "NSG allows ALL inbound ports from the internet");
      const [lo, hi = lo] = pr[1].split("-").map(Number); const p = exposedPort(lo, hi);
      if (p) add("error", file, i + 1, `port ${p} (${SENSITIVE[p]}) is open to the internet in an NSG rule`);
    }
  });
}

function enclosingObject(text, idx) {
  let depth = 0, start = -1;
  for (let k = idx; k >= 0; k--) { const c = text[k]; if (c === "}") depth++; else if (c === "{") { if (depth === 0) { start = k; break; } depth--; } }
  if (start < 0) return null;
  depth = 0;
  for (let k = start; k < text.length; k++) { const c = text[k]; if (c === "{") depth++; else if (c === "}" && --depth === 0) return text.slice(start, k + 1); }
  return text.slice(start);
}
// YAML has no braces: a statement is the list item that contains the line.
function yamlItem(lines, i) {
  let a = i; while (a > 0 && !/^\s*-\s/.test(lines[a])) a--;
  let b = i + 1; while (b < lines.length && !/^\s*-\s/.test(lines[b])) b++;
  return lines.slice(a, b).join("\n");
}

function scanIac(text, file, kind, gitignore, add) {
  const lines = text.split("\n");
  const rule = (re, level, msg, ok) => { for (const m of text.matchAll(re)) { if (ok && ok(m)) continue; add(level, file, lineOf(text, m.index), msg); } };
  checkOpenNetwork(lines, file, add);
  // S3
  rule(/\bacl\s*=\s*"public-read(-write)?"|AccessControl:\s*['"]?PublicRead(Write)?\b/g, "error", "S3 bucket ACL makes objects public");
  rule(/(block_public_acls|block_public_policy|ignore_public_acls|restrict_public_buckets|BlockPublicAcls|BlockPublicPolicy|IgnorePublicAcls|RestrictPublicBuckets)\W+false\b/gi, "warn", "S3 public access block is disabled");
  // IAM: judge each statement on its own (never a window that reaches into a neighbouring policy)
  let offset = 0;
  lines.forEach((l, i) => {
    const at = offset; offset += l.length + 1;
    if (/["']?\bAction["']?\s*[:=]\s*(\[\s*)?["']\*["']|\bactions\s*=\s*\[\s*"\*"\s*\]|(^|\s)Action:\s*\*\s*$/i.test(l)) {
      const stmt = enclosingObject(text, at + l.search(/\S/)) || yamlItem(lines, i);
      if (/["']?(Resource|resources)["']?\s*[:=]\s*(\[\s*)?["']\*["']/i.test(stmt) && !/Deny/.test(stmt)) add("error", file, i + 1, "IAM policy grants Action * on Resource * (full admin): scope it to what the app needs");
      else add("warn", file, i + 1, "IAM policy uses Action *: list only the actions required");
    }
    if (/["']?Principal["']?\s*[:=]\s*["']\*["']|Principal["']?\s*:\s*\{\s*["']?AWS["']?\s*:\s*["']\*["']/.test(l) && !/Deny/.test(enclosingObject(text, at + l.search(/\S/)) || yamlItem(lines, i))) add("error", file, i + 1, "policy Principal is * (anyone): restrict to specific accounts/roles");
  });
  // RDS / databases
  rule(/(publicly_accessible|PubliclyAccessible)\W+true\b/gi, "error", "database is publicly accessible: put it in a private subnet");
  rule(/(storage_encrypted|StorageEncrypted|encrypted)\W+false\b/gi, "warn", "storage encryption is disabled");
  rule(/(backup_retention_period|BackupRetentionPeriod)\W+0\b/gi, "warn", "database backups are disabled (retention 0)");
  // Azure
  rule(/(supportsHttpsTrafficOnly|enable_https_traffic_only|https_traffic_only_enabled)\W+false\b/gi, "error", "storage account allows plain HTTP");
  rule(/(allowBlobPublicAccess|allow_blob_public_access|allow_nested_items_to_be_public)\W+true\b/gi, "warn", "storage account allows public blob access");
  rule(/(minimumTlsVersion|min_tls_version|minTlsVersion)\W+["']?TLS1_?[01]\b/gi, "warn", "minimum TLS version below 1.2");
  rule(/(httpsOnly|https_only)\W+false\b/gi, "warn", "App Service accepts plain HTTP: set httpsOnly true");
  lines.forEach((l, i) => { if (/(start_?ip_?address)\W+["']?0\.0\.0\.0["']?/i.test(l) && /(end_?ip_?address)\W+["']?255\.255\.255\.255/i.test(win(lines, i, 3, 3))) add("error", file, i + 1, "SQL firewall rule allows every IP address (0.0.0.0 - 255.255.255.255)"); });
  rule(/(publicNetworkAccess|public_network_access_enabled)\W+(["']?Enabled["']?|true)\b/gi, "info", "public network access is enabled: use private endpoints if the service is internal");
  // hardcoded credentials in IaC
  rule(/\b(administratorLoginPassword|administrator_login_password|admin_password|master_password|db_password|password)\s*[:=]\s*(["'])(?!\s*\2)([^"'$]{3,})\2/gi, "error", "hardcoded password in infrastructure code: use a secret store or a sensitive variable", (m) => /^<.*>$/.test(m[3]));
  rule(/\bparam\s+\w*(password|secret|key)\w*\s+string\s*=\s*'[^']+'/gi, "error", "Bicep parameter has a literal secret default");
  if (kind === "bicep") lines.forEach((l, i) => {
    const m = l.match(/^\s*param\s+(\w*(?:password|secret)\w*)\s+string/i);
    const decorators = []; for (let k = i - 1; k >= 0 && /^\s*@/.test(lines[k]); k--) decorators.push(lines[k]);   // only the stack of @decorators directly above
    if (m && !decorators.some((d) => /@secure\(\)/.test(d))) add("warn", file, i + 1, `Bicep parameter ${m[1]} should be decorated with @secure()`);
  });
  if (kind === "cfn" || kind === "serverless") rule(/^\s*(\w*(?:SECRET|PASSWORD|TOKEN|API_?KEY|PRIVATE_?KEY)\w*)\s*:\s*['"]?([A-Za-z0-9/+=_.\-]{8,})['"]?\s*$/gim, "error", "secret stored as a plain environment value: use Secrets Manager / SSM (resolve at deploy or runtime)", (m) => /^[!$&*{]|^\/aws|^resolve:|^arn:/i.test(m[2]));
  if (kind === "tf") {
    if (/\.tfvars$/.test(file) && !/tfvars/.test(gitignore) && /(password|secret|token|key)\s*=\s*"/i.test(text)) add("error", file, 1, "*.tfvars with secrets is not git-ignored");
  }
}

function scanCode(text, file, add) {
  const rule = (re, level, msg) => { for (const m of text.matchAll(re)) add(level, file, lineOf(text, m.index), msg); };
  rule(/accessKeyId\s*:\s*['"][A-Z0-9]{16,}['"]|secretAccessKey\s*:\s*['"][^'"$]{20,}['"]|aws_(access_key_id|secret_access_key)\s*=\s*['"][^'"]{16,}['"]/gi, "error", "AWS credentials hardcoded in code: use an IAM role (ECS/Lambda/EC2) or environment-provided temporary credentials");
  rule(/AccountKey=[A-Za-z0-9+/=]{20,}/g, "error", "Azure storage account key in code/config: use DefaultAzureCredential (managed identity) or Key Vault");
  rule(/[?&]sv=\d{4}-\d{2}-\d{2}[^'"\s]*&sig=[A-Za-z0-9%+/=]{20,}/g, "error", "Azure SAS token in code/config: generate short-lived SAS at runtime");
  rule(/(client_?secret|AZURE_CLIENT_SECRET)\s*[:=]\s*['"][^'"$]{10,}['"]/gi, "error", "Azure client secret hardcoded: use managed identity or workload identity federation");
  if (/\.(m?[jt]sx?|cjs|py)$/.test(file) && !/(^|\/)(scripts?|migrations?)\//.test(file)) {
    rule(/process\.env\.AWS_SECRET_ACCESS_KEY|os\.environ\[['"]AWS_SECRET_ACCESS_KEY['"]\]/g, "warn", "long-lived AWS keys read from env: prefer an IAM role so there is no key to leak");
    rule(/ACL\s*:\s*['"]public-read(-write)?['"]/g, "warn", "S3 object uploaded with a public ACL");
    rule(/(publicAccessLevel|public_access)\s*[:=]\s*['"](blob|container)['"]/gi, "warn", "blob container created with public access");
  }
}

function scanWorkflow(text, file, add) {
  for (const m of text.matchAll(/aws-access-key-id\s*:\s*\$\{\{\s*secrets\./gi)) add("info", file, lineOf(text, m.index), "long-lived AWS keys in CI: switch to OIDC (role-to-assume)");
  for (const m of text.matchAll(/creds\s*:\s*\$\{\{\s*secrets\.\w+\s*\}\}/gi)) add("info", file, lineOf(text, m.index), "Azure service-principal secret in CI: switch to OIDC federated credentials (client-id/tenant-id/subscription-id)");
}

export function scanCloud(cwd) {
  const cloud = detectCloud(cwd), findings = [];
  const gi = read(path.join(cwd, ".gitignore"));
  const add = (level, file, line, msg) => findings.push({ level, file, line, msg });
  const seen = new Set();
  const uniq = (level, file, line, msg) => { const k = `${file}:${line}:${msg}`; if (!seen.has(k)) { seen.add(k); add(level, file, line, msg); } };
  for (const f of walk(cwd)) {
    const base = path.basename(f);
    if (/\.(sample|example|template)$|^\.env\.(example|sample|template)$/.test(base) || base === "package-lock.json") continue;
    const text = read(path.join(cwd, f));
    if (!text || text.length > 400_000) continue;
    const kind = kindOf(f, text);
    if (["tf", "bicep", "cfn", "arm", "serverless"].includes(kind)) scanIac(text, f, kind, gi, uniq);
    else if (kind === "workflow" || kind === "azpipe") scanWorkflow(text, f, uniq);
    scanCode(text, f, uniq);
    if (/^\.env(\.|$)/.test(base) && /(AWS_SECRET_ACCESS_KEY|AccountKey|AZURE_CLIENT_SECRET)\s*=\s*\S{8,}/.test(text) && !/(^|\n)\.env\s*($|\n)/.test(gi)) uniq("error", f, 1, "cloud secret in a .env file that is not git-ignored");
  }
  for (const f of fs.readdirSync(cwd)) {
    if (/^terraform\.tfstate(\.backup)?$/.test(f) && !/tfstate/.test(gi)) uniq("error", f, 1, "Terraform state file contains secrets: use a remote backend (S3+DynamoDB lock / Azure Storage) and git-ignore it");
    if (f === ".terraform" && !/\.terraform/.test(gi)) uniq("warn", f, 1, ".terraform/ directory is not git-ignored");
  }
  return { findings, cloud };
}

export function renderCloud({ findings, cloud }) {
  const names = { aws: "AWS", azure: "Azure" };
  return `# Cloud Map (auto-generated by \`agentforge cloud\`)

Static analysis of SDK usage, infrastructure-as-code and CI files. It never connects to your cloud account, so it cannot see what is actually deployed.

**Providers:** ${cloud.providers.map((p) => names[p]).join(", ") || "none detected"}

## Services used by code

${cloud.services.length ? cloud.services.map((s) => `- ${names[s.provider]} ${s.name} (\`${s.dir}\`)`).join("\n") : "None detected."}

## Infrastructure and deploy files

${[...cloud.iac.map((f) => `- ${f.kind}: \`${f.file}\``), ...cloud.deploy.map((f) => `- deploy pipeline: \`${f}\``)].join("\n") || "None detected."}

## Findings

${findings.length ? findings.map((f) => `- **${f.level}** \`${f.file}:${f.line}\` ${f.msg}`).join("\n") : "None."}
`;
}

// ---------- scaffold ----------
export function cloudInit(cwd, provider, { force = false } = {}) {
  if (!["aws", "azure"].includes(provider)) throw new Error("Usage: agentforge cloud init aws | azure");
  const svcs = findServices(cwd).filter((s) => s.kind === "api" || s.kind === "worker");
  const svc = svcs.find((s) => fs.existsSync(path.join(cwd, s.dir, "Dockerfile"))) || svcs[0];
  const context = svc ? svc.dir : ".";
  const port = svc?.lang === "python" ? 8000 : 3000;
  const created = [], skipped = [], notes = [];
  if (!svc || !fs.existsSync(path.join(cwd, svc.dir, "Dockerfile"))) notes.push("No Dockerfile found: run `agentforge docker init` first (the workflow builds and pushes a container image).");
  const files = provider === "aws"
    ? [["deploy-aws.yml", ".github/workflows/deploy-aws.yml"], ["ecs-task-definition.json", "infra/aws/ecs-task-definition.json"], ["github-oidc-trust-policy.json", "infra/aws/github-oidc-trust-policy.json"], ["ecr-ecs-deploy-policy.json", "infra/aws/ecr-ecs-deploy-policy.json"], ["README.md", "infra/aws/README.md"]]
    : [["deploy-azure.yml", ".github/workflows/deploy-azure.yml"], ["federated-credential.json", "infra/azure/federated-credential.json"], ["README.md", "infra/azure/README.md"]];
  for (const [src, dest] of files) {
    const target = path.join(cwd, dest);
    if (fs.existsSync(target) && !force) { skipped.push(dest); continue; }
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, read(path.join(T, provider, src)).replaceAll("__CONTEXT__", context).replaceAll("__PORT__", String(port)));
    created.push(dest);
  }
  return { created, skipped, notes, context };
}
