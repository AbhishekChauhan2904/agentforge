import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { W, tmp } from "./fixtures.js";
import { scanCloud, detectCloud, cloudInit } from "../src/cloud.js";
import { generate } from "../src/generator.js";
import { runGate } from "../src/gate.js";
import { buildGraph } from "../src/graph.js";
import { scanSecrets } from "../src/secrets.js";
import { buildPipeline } from "../src/state.js";
import { lintPrompts } from "../src/doctor.js";

const has = (r, re, level) => r.findings.some((f) => re.test(f.msg) && (!level || f.level === level));
const at = (r, re) => r.findings.filter((f) => re.test(f.msg));

test("detects providers and services from SDKs, IaC and CI", () => {
  const d = tmp();
  W(d, "api/package.json", JSON.stringify({ name: "api", dependencies: { express: "4", "@aws-sdk/client-s3": "3", "@aws-sdk/client-dynamodb": "3", "@aws-sdk/lib-dynamodb": "3", "@azure/storage-blob": "12", "@azure/identity": "4" } }));
  W(d, "worker/requirements.txt", "flask\nboto3\nazure-cosmos\n"); W(d, "worker/app.py", "import boto3\nq = boto3.client('sqs')\ns3 = boto3.resource(\"s3\")\n");
  W(d, "infra/main.tf", 'provider "aws" {}\nresource "aws_s3_bucket" "b" {}\n');
  W(d, "infra/az.bicep", "resource sa 'Microsoft.Storage/storageAccounts@2023-01-01' = {}\n");
  W(d, ".github/workflows/ci.yml", "jobs:\n  d:\n    steps:\n      - uses: aws-actions/configure-aws-credentials@v4\n");
  const c = detectCloud(d);
  assert.deepEqual(c.providers, ["aws", "azure"]);
  const names = c.services.map((s) => `${s.provider}:${s.name}`);
  for (const n of ["aws:S3", "aws:DynamoDB", "azure:Blob Storage", "azure:Entra ID / Managed Identity", "aws:SQS", "azure:Cosmos DB"]) assert.ok(names.includes(n), n);
  assert.equal(names.filter((n) => n === "aws:DynamoDB").length, 1);   // two SDK packages, one service
  assert.deepEqual(c.iac.map((i) => i.kind).sort(), ["bicep", "terraform"]);
  assert.equal(c.deploy.length, 1);
  assert.deepEqual(detectCloud(tmp()).providers, []);
});

test("terraform: dangerous settings are errors, safe ones are not", () => {
  const d = tmp();
  W(d, "main.tf", `resource "aws_security_group" "web" {
  ingress {
    from_port   = 22
    to_port     = 22
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  ingress {
    from_port   = 443
    to_port     = 443
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
  egress {
    from_port   = 0
    to_port     = 0
    protocol    = "-1"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
resource "aws_security_group" "db" {
  ingress {
    from_port   = 5000
    to_port     = 6000
    protocol    = "tcp"
    cidr_blocks = ["0.0.0.0/0"]
  }
}
resource "aws_s3_bucket_acl" "a" { acl = "public-read" }
resource "aws_iam_policy" "admin" {
  policy = jsonencode({ Statement = [{ Effect = "Allow", Action = "*", Resource = "*" }] })
}
resource "aws_iam_policy" "wild" {
  policy = jsonencode({ Statement = [{ Effect = "Allow", Action = "*", Resource = "arn:aws:s3:::b/*" }] })
}
resource "aws_db_instance" "db" {
  publicly_accessible = true
  storage_encrypted   = false
  password            = "SuperSecret123"
}
resource "aws_db_instance" "ok" {
  publicly_accessible = false
  storage_encrypted   = true
  password            = var.db_password
}
resource "aws_db_instance" "placeholder" {
  password = "<REPLACE_ME>"
}
`);
  const r = scanCloud(d);
  assert.equal(at(r, /port 22 \(SSH\) is open to the internet/).length, 1);
  assert.equal(at(r, /port 5432 \(PostgreSQL\) is open/).length, 1);       // 5000-6000 covers 5432
  assert.equal(r.findings.filter((f) => f.level === "error" && /port 443|ALL traffic/.test(f.msg)).length, 0);   // 443 ok, egress ok
  assert.ok(has(r, /ACL makes objects public/, "error"));
  assert.ok(has(r, /Action \* on Resource \*/, "error"));
  assert.ok(has(r, /uses Action \*: list only/, "warn"));
  assert.ok(has(r, /publicly accessible/, "error"));
  assert.ok(has(r, /encryption is disabled/, "warn"));
  assert.equal(at(r, /hardcoded password/).length, 1);                    // literal only; var.db_password and <REPLACE_ME> are fine
});

test("terraform state and tfvars secrets", () => {
  const d = tmp();
  W(d, "terraform.tfstate", "{}"); W(d, "prod.tfvars", 'db_password = "abc12345"\n');
  assert.ok(has(scanCloud(d), /Terraform state file/, "error"));
  assert.ok(has(scanCloud(d), /\*\.tfvars with secrets is not git-ignored/, "error"));
  W(d, ".gitignore", "*.tfstate\n*.tfvars\n.terraform\n");
  const r = scanCloud(d);
  assert.equal(at(r, /Terraform state file|tfvars with secrets/).length, 0);
});

test("azure bicep and terraform settings", () => {
  const d = tmp();
  W(d, "main.bicep", `@secure()
param adminPassword string
param dbPassword string
param sqlSecret string = 'hunter2hunter2'
resource sa 'Microsoft.Storage/storageAccounts@2023-01-01' = {
  properties: {
    supportsHttpsTrafficOnly: false
    allowBlobPublicAccess: true
    minimumTlsVersion: 'TLS1_0'
  }
}
resource fw 'Microsoft.Sql/servers/firewallRules@2023-01-01' = {
  properties: {
    startIpAddress: '0.0.0.0'
    endIpAddress: '255.255.255.255'
  }
}
resource app 'Microsoft.Web/sites@2023-01-01' = {
  properties: { httpsOnly: false }
}
`);
  W(d, "nsg.tf", `resource "azurerm_network_security_rule" "ssh" {
  name                       = "ssh"
  direction                  = "Inbound"
  access                     = "Allow"
  protocol                   = "Tcp"
  destination_port_range     = "22"
  source_address_prefix      = "*"
}
resource "azurerm_network_security_rule" "https" {
  direction                  = "Inbound"
  access                     = "Allow"
  destination_port_range     = "443"
  source_address_prefix      = "*"
}
`);
  const r = scanCloud(d);
  assert.ok(has(r, /storage account allows plain HTTP/, "error"));
  assert.ok(has(r, /public blob access/, "warn"));
  assert.ok(has(r, /minimum TLS version below 1.2/, "warn"));
  assert.ok(has(r, /SQL firewall rule allows every IP/, "error"));
  assert.ok(has(r, /plain HTTP: set httpsOnly/, "warn"));
  assert.ok(has(r, /Bicep parameter has a literal secret default/, "error"));
  assert.equal(at(r, /dbPassword should be decorated with @secure/).length, 1);
  assert.equal(at(r, /adminPassword should be decorated/).length, 0);
  assert.equal(at(r, /port 22 \(SSH\) is open to the internet in an NSG/).length, 1);
  assert.equal(r.findings.filter((f) => /NSG/.test(f.msg) && /443/.test(f.msg)).length, 0);
});

test("cloudformation / serverless: open DB port, public bucket, plaintext secrets", () => {
  const d = tmp();
  W(d, "template.yaml", `AWSTemplateFormatVersion: '2010-09-09'
Resources:
  DbSg:
    Type: AWS::EC2::SecurityGroup
    Properties:
      SecurityGroupIngress:
        - IpProtocol: tcp
          FromPort: 3306
          ToPort: 3306
          CidrIp: 0.0.0.0/0
  Bucket:
    Type: AWS::S3::Bucket
    Properties:
      AccessControl: PublicRead
  Fn:
    Type: AWS::Lambda::Function
    Properties:
      Environment:
        Variables:
          API_KEY: abcd1234efgh5678
          DB_PASSWORD: !Ref DbPass
          TOKEN_SSM: '{{resolve:ssm:/app/token}}'
`);
  const r = scanCloud(d);
  assert.ok(has(r, /port 3306 \(MySQL\) is open/, "error"));
  assert.ok(has(r, /ACL makes objects public/, "error"));
  assert.equal(at(r, /secret stored as a plain environment value/).length, 1);   // API_KEY only
});

test("code: hardcoded cloud credentials are errors; managed identity is fine", () => {
  const d = tmp();
  W(d, "package.json", JSON.stringify({ name: "a", dependencies: { express: "4" } }));
  W(d, "src/bad.js", `const s3 = new AWS.S3({ accessKeyId: 'AKIAIOSFODNN7EXAMPLE', secretAccessKey: 'wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY' });
const conn = 'DefaultEndpointsProtocol=https;AccountName=acct;AccountKey=Eby8vdM02xNOcqFlqUwJPLlmEtlCDXJ1OUzFT50uSRZ6IFsuFq2UVErCz4I6tq/K1SZFPTOtr/KBHBeksoGMGw==;EndpointSuffix=core.windows.net';
const sas = 'https://a.blob.core.windows.net/c?sv=2022-11-02&ss=b&sig=abcdefghijklmnopqrstuvwx%3D';
const k = process.env.AWS_SECRET_ACCESS_KEY;
s3.putObject({ Bucket: 'b', Key: 'k', ACL: 'public-read' });
`);
  W(d, "src/good.js", "const cred = new DefaultAzureCredential();\nconst client = new BlobServiceClient(url, cred);\nconst s3 = new S3Client({ region: 'us-east-1' });\n");
  const r = scanCloud(d);
  assert.equal(at(r, /AWS credentials hardcoded/).length, 1);
  assert.equal(at(r, /Azure storage account key/).length, 1);
  assert.equal(at(r, /Azure SAS token/).length, 1);
  assert.ok(has(r, /long-lived AWS keys read from env/, "warn"));
  assert.ok(has(r, /public ACL/, "warn"));
  assert.ok(r.findings.every((f) => f.file.endsWith("bad.js")));
  assert.ok(scanSecrets(d).some((h) => /Azure storage account key/.test(h.rule)));   // the secret scanner also knows Azure keys now
});

test("CI workflows with long-lived keys get an info finding, OIDC gets none", () => {
  const d = tmp();
  W(d, ".github/workflows/old.yml", "jobs:\n  d:\n    steps:\n      - uses: aws-actions/configure-aws-credentials@v4\n        with:\n          aws-access-key-id: ${{ secrets.AWS_ID }}\n      - uses: azure/login@v2\n        with:\n          creds: ${{ secrets.AZURE_CREDENTIALS }}\n");
  W(d, ".github/workflows/new.yml", "jobs:\n  d:\n    steps:\n      - uses: aws-actions/configure-aws-credentials@v4\n        with:\n          role-to-assume: ${{ vars.ROLE }}\n");
  const r = scanCloud(d);
  assert.equal(r.findings.filter((f) => f.level === "info").length, 2);
  assert.ok(r.findings.every((f) => f.file.endsWith("old.yml")));
});

test("cloud init scaffolds OIDC deploy files, never overwrites, and passes its own checks", () => {
  const d = tmp();
  W(d, "api/package.json", JSON.stringify({ name: "api", scripts: { start: "node a.js" }, dependencies: { express: "4" } }));
  const noDocker = cloudInit(d, "aws");
  assert.ok(noDocker.notes.some((n) => /docker init/.test(n)));
  W(d, "api/Dockerfile", "FROM node:20\n");
  const a = cloudInit(d, "aws", { force: true });
  assert.deepEqual(a.created.sort(), [".github/workflows/deploy-aws.yml", "infra/aws/README.md", "infra/aws/ecr-ecs-deploy-policy.json", "infra/aws/ecs-task-definition.json", "infra/aws/github-oidc-trust-policy.json"]);
  const wf = fs.readFileSync(path.join(d, ".github/workflows/deploy-aws.yml"), "utf8");
  assert.match(wf, /id-token: write/); assert.match(wf, /role-to-assume/); assert.match(wf, /docker build -t "\$IMAGE" api/); assert.doesNotMatch(wf, /__CONTEXT__|aws-access-key-id/);
  const td = JSON.parse(fs.readFileSync(path.join(d, "infra/aws/ecs-task-definition.json"), "utf8"));
  assert.equal(td.containerDefinitions[0].portMappings[0].containerPort, 3000);
  assert.ok(td.containerDefinitions[0].secrets.every((s) => /secretsmanager|ssm/.test(s.valueFrom)));
  const z = cloudInit(d, "azure");
  assert.deepEqual(z.created.sort(), [".github/workflows/deploy-azure.yml", "infra/azure/README.md", "infra/azure/federated-credential.json"]);
  assert.match(fs.readFileSync(path.join(d, ".github/workflows/deploy-azure.yml"), "utf8"), /az acr build[\s\S]*api/);
  assert.equal(cloudInit(d, "aws").created.length, 0);                                   // idempotent
  assert.deepEqual(scanCloud(d).findings.filter((f) => f.level !== "info"), []);        // scaffold is clean (placeholders are not secrets)
  assert.throws(() => cloudInit(d, "gcp"), /aws \| azure/);
  const p = tmp(); W(p, "svc/requirements.txt", "fastapi\n"); W(p, "svc/main.py", ""); W(p, "svc/Dockerfile", "FROM python:3.12\n");
  cloudInit(p, "aws"); assert.equal(JSON.parse(fs.readFileSync(path.join(p, "infra/aws/ecs-task-definition.json"), "utf8")).containerDefinitions[0].portMappings[0].containerPort, 8000);
});

test("init enables cloudCheck only when cloud is detected; gate blocks on cloud errors", () => {
  const plain = tmp(); W(plain, "package.json", JSON.stringify({ name: "p", scripts: { test: 'node -e "process.exit(0)"' } }));
  generate({ tool: "cursor", workflow: "standard" }, plain);
  assert.equal(JSON.parse(fs.readFileSync(path.join(plain, ".ai/config.json"), "utf8")).cloudCheck, undefined);
  assert.ok(!fs.existsSync(path.join(plain, ".ai/cloud.md")));
  const d = tmp();
  W(d, "package.json", JSON.stringify({ name: "p", scripts: { test: 'node -e "process.exit(0)"' } }));
  W(d, "infra/main.tf", 'resource "aws_db_instance" "db" {\n  publicly_accessible = true\n}\n');
  generate({ tool: "opencode", workflow: "full", specialists: ["aws", "azure"] }, d);
  assert.equal(JSON.parse(fs.readFileSync(path.join(d, ".ai/config.json"), "utf8")).cloudCheck, true);
  assert.match(fs.readFileSync(path.join(d, ".ai/cloud.md"), "utf8"), /Providers:\*\* AWS/);
  assert.match(fs.readFileSync(path.join(d, ".ai/project-context.md"), "utf8"), /\| Cloud \| AWS \|/);
  const g = runGate(d);
  assert.equal(g.results.find((x) => x.name === "Cloud Security").status, "FAIL");
  assert.equal(g.passed, false);
  assert.ok(fs.existsSync(path.join(d, ".opencode/agents/aws.md")) && fs.existsSync(path.join(d, ".opencode/agents/azure.md")));
});

test("graph shows cloud services; pipeline places cloud agents after devops; prompts lint", () => {
  const d = tmp();
  W(d, "api/package.json", JSON.stringify({ name: "api", dependencies: { express: "4", "@aws-sdk/client-s3": "3", "@azure/storage-blob": "12" } }));
  const m = buildGraph(d).system.mermaid;
  assert.match(m, /n_api -->\|uses\| cloud_aws_S3/); assert.match(m, /cloud_aws_S3\{\{"AWS S3"\}\}/); assert.match(m, /\{\{"Azure Blob Storage"\}\}/);
  assert.deepEqual(buildPipeline({ workflow: "full", agents: ["orchestrator", "planner", "qa", "security", "reviewer", "docs", "git", "backend", "docker", "devops", "aws", "azure"] }),
    ["planner", "backend", "docker", "devops", "aws", "azure", "qa", "security", "reviewer", "gate", "docs", "git"]);
  assert.deepEqual(lintPrompts(), []);
});
