import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { scanApi } from "../src/api.js";
import { scanDb } from "../src/dbcheck.js";
import { checkStructure } from "../src/structure.js";
import { generate } from "../src/generator.js";
import { runGate } from "../src/gate.js";
import { findServices } from "../src/services.js";
import { moduleGraph } from "../src/graph.js";
import { dockerInit, lintDocker } from "../src/docker.js";
import { lintPrompts } from "../src/doctor.js";

import { W, tmp, express, flutterApp } from "./fixtures.js";
const find = (r, re, level) => r.findings.filter((f) => re.test(f.msg) && (!level || f.level === level));
const ep = (r, m, p) => r.endpoints.find((e) => e.method === m && e.path === p);

test("express: mounts, prefixes and inherited auth middleware are resolved", () => {
  const r = scanApi(express());
  assert.equal(ep(r, "POST", "/api/auth/login").auth, false);
  assert.equal(ep(r, "GET", "/api/tickets").auth, true);              // inherited from app.use('/api/tickets', authenticate, router)
  assert.equal(ep(r, "PUT", "/api/tickets/:id").auth, true);
  assert.equal(ep(r, "DELETE", "/api/tickets/:id").auth, true);       // router.route().delete chain
  assert.equal(ep(r, "GET", "/api/admin/users").auth, false);
  assert.equal(ep(r, "POST", "/api/auth/register").rateLimit, true);
  assert.equal(ep(r, "POST", "/api/tickets").validation, true);
  assert.equal(ep(r, "GET", "/health").framework, "express");
});

test("express: findings (unprotected mutating admin route, IDOR, rate limit, cors, helmet)", () => {
  const r = scanApi(express());
  assert.ok(find(r, /DELETE \/api\/admin\/users\/:id changes data without authentication/, "error").length);
  assert.ok(find(r, /GET \/api\/admin\/users is readable without authentication/, "warn").length);
  assert.ok(find(r, /PUT \/api\/tickets\/:id acts on a record by id.*IDOR/, "warn").length);
  assert.equal(find(r, /DELETE \/api\/tickets\/:id acts on a record/).length, 0);   // has owner check
  assert.ok(find(r, /POST \/api\/auth\/login has no rate limiting/).length);
  assert.equal(find(r, /POST \/api\/auth\/register has no rate limiting/).length, 0);
  assert.ok(find(r, /CORS allows every origin/).length);
  assert.ok(find(r, /helmet/).length);
  assert.equal(find(r, /POST \/api\/auth\/login changes data without authentication/).length, 0);   // public path allow-list
});

test("hardcoded JWT secrets are errors", () => {
  const d = tmp();
  W(d, "package.json", JSON.stringify({ name: "s", dependencies: { express: "4" } }));
  W(d, "src/a.js", "const token = jwt.sign({ id: 1 }, 'mysecret123');\nconst JWT_SECRET = process.env.JWT_SECRET || 'fallback-secret';\n");
  assert.equal(find(scanApi(d), /secret/, "error").length, 2);
});

test("fastapi: Depends-based auth, router prefix and dependencies", () => {
  const d = tmp();
  W(d, "api/requirements.txt", "fastapi\nuvicorn\npyjwt\nsqlalchemy\npsycopg2\n");
  W(d, "api/main.py", "from fastapi import FastAPI\nfrom routers import items, users\napp = FastAPI()\napp.include_router(items.router, prefix='/items')\napp.include_router(users.router, prefix='/users', dependencies=[Depends(get_current_user)])\n");
  W(d, "api/routers/items.py", `from fastapi import APIRouter, Depends
router = APIRouter()

@router.get("/")
def list_items(db=Depends(get_db)):
    return []

@router.post("/")
def create_item(item: ItemCreate, user=Depends(get_current_user)):
    return item

@router.delete("/{item_id}")
def delete_item(item_id: int, db=Depends(get_db)):
    return {}
`);
  W(d, "api/routers/users.py", `from fastapi import APIRouter, Depends
router = APIRouter()

@router.get("/me")
def me():
    return {}

@router.delete("/{uid}")
def rm(uid: int, admin=Depends(require_admin)):
    return {}
`);
  const r = scanApi(d);
  assert.equal(ep(r, "POST", "/items").auth, true);
  assert.equal(ep(r, "POST", "/items").validation, true);
  assert.equal(ep(r, "GET", "/items").auth, false);
  assert.equal(ep(r, "DELETE", "/items/{item_id}").auth, false);
  assert.equal(ep(r, "GET", "/users/me").auth, true);                   // router-level dependency from include_router
  assert.equal(ep(r, "DELETE", "/users/{uid}").roles, true);
  assert.ok(find(r, /DELETE \/items\/\{item_id\} changes data without authentication/, "error").length);
  assert.equal(findServices(d)[0].framework, "fastapi");
});

test("flask: decorators and blueprint prefix", () => {
  const d = tmp();
  W(d, "requirements.txt", "flask\nflask-jwt-extended\n");
  W(d, "app.py", `from flask import Flask, Blueprint, request
from flask_jwt_extended import jwt_required
app = Flask(__name__)
bp = Blueprint('orders', __name__, url_prefix='/orders')

@bp.route('/', methods=['GET'])
def list_orders():
    return []

@bp.route('/', methods=['POST'])
@jwt_required()
def create_order():
    data = request.get_json()
    return data

@bp.route('/<int:oid>', methods=['DELETE'])
def delete_order(oid):
    return {}

@app.route('/admin/purge', methods=['POST'])
@jwt_required()
def purge():
    return {}
`);
  const r = scanApi(d);
  assert.equal(ep(r, "POST", "/orders").auth, true);
  assert.equal(ep(r, "DELETE", "/orders/<int:oid>").auth, false);
  assert.ok(find(r, /DELETE \/orders\/<int:oid> changes data without authentication/, "error").length);
  assert.ok(find(r, /POST \/orders has no visible input validation/).length);
  assert.ok(find(r, /POST \/admin\/purge is an admin route with no role/).length);
});

test("django rest: permission_classes and AllowAny", () => {
  const d = tmp();
  W(d, "requirements.txt", "django\ndjangorestframework\n");
  W(d, "manage.py", "");
  W(d, "app/views.py", `from rest_framework.views import APIView
class PublicView(APIView):
    permission_classes = [AllowAny]
    def post(self, request): return None

class SecureView(APIView):
    permission_classes = [IsAuthenticated]
    serializer_class = ThingSerializer
    def post(self, request): return None
`);
  const r = scanApi(d);
  assert.equal(r.endpoints.find((e) => e.path === "PublicView").auth, false);
  assert.equal(r.endpoints.find((e) => e.path === "SecureView").auth, true);
});

test("db: mongoose schema problems and injection patterns", () => {
  const d = express();
  W(d, "server/src/controllers/bad.js", `exports.a = (req,res) => User.findOne(req.body);
exports.b = (req,res) => Ticket.findByIdAndUpdate(req.params.id, req.body);
exports.c = (req,res) => db.query("SELECT * FROM t WHERE id=" + req.params.id);
exports.d = (req,res) => Ticket.find({ $where: 'this.a == 1' });
`);
  const r = scanDb(d);
  assert.deepEqual(r.models.map((m) => m.name).sort(), ["Ticket", "User"]);
  assert.ok(find(r, /User\.password is returned by default/).length);
  assert.ok(find(r, /User\.email is not unique/).length);
  assert.ok(find(r, /User\.role has no enum/).length);
  assert.ok(find(r, /Ticket: no timestamps/).length);
  assert.equal(find(r, /User: no timestamps/).length, 0);
  assert.ok(find(r, /Ticket\.owner references another collection/, "info").length);
  assert.ok(find(r, /NoSQL injection/, "error").length >= 2);          // controllers/bad.js + authController login(findOne(req.body))
  assert.ok(find(r, /mass assignment/, "warn").length >= 2);            // findByIdAndUpdate + ticketController create
  assert.ok(find(r, /SQL injection/, "error").length);
  assert.ok(find(r, /\$where/, "error").length);
});

test("db: prisma, sqlalchemy and django models", () => {
  const d = tmp();
  W(d, "api/package.json", JSON.stringify({ name: "api", dependencies: { express: "4", "@prisma/client": "5" } }));
  W(d, "api/prisma/schema.prisma", "model Post {\n  id Int @id\n  email String\n  authorId Int\n  author User @relation(fields: [authorId], references: [id])\n}\nmodel User {\n  id Int @id\n  email String @unique\n}\n");
  W(d, "py/requirements.txt", "fastapi\nsqlalchemy\n");
  W(d, "py/models.py", "class Order(Base):\n    __tablename__ = 'orders'\n    id = Column(Integer, primary_key=True)\n    email = Column(String)\n    user_id = Column(Integer, ForeignKey('users.id'))\n");
  W(d, "py/db.py", "def q(cur, x):\n    cur.execute(f\"SELECT * FROM t WHERE a = {x}\")\n");
  const r = scanDb(d);
  assert.ok(find(r, /Post\.email is not unique/).length);
  assert.ok(find(r, /Post\.authorId is a foreign key with no @@index/).length);
  assert.equal(find(r, /User\.email is not unique/).length, 0);
  assert.ok(find(r, /Order\.user_id is a foreign key without index/).length);
  assert.ok(find(r, /Order\.email is not unique/).length);
  assert.ok(find(r, /SQL injection/, "error").length);
});

test("structure: layer violations (model -> route), fat routes, cycles", () => {
  const r = checkStructure(express());
  assert.equal(find(r, /layer violation/, "error").length, 0);   // the base fixture respects the layering
  const d = express();
  W(d, "server/src/models/Ticket.js", fs.readFileSync(path.join(d, "server/src/models/Ticket.js"), "utf8") + "const bad = require('../controllers/ticketController');\n");
  const r2 = checkStructure(d);
  assert.ok(find(r2, /layer violation: models imports controllers/, "error").length);
  assert.ok(find(r2, /circular dependency between controllers, models/, "error").length);
  const d3 = tmp();
  W(d3, "package.json", JSON.stringify({ name: "x", dependencies: { express: "4" } }));
  W(d3, "src/routes/a.js", "const m = require('../models/m');\n"); W(d3, "src/models/m.js", "module.exports={};\n"); W(d3, "src/app.js", "require('./routes/a');\n");
  const r3 = checkStructure(d3);
  assert.ok(find(r3, /no controllers\/ or services\/ layer/, "warn").length);
  assert.ok(find(r3, /routes imports models directly/, "warn").length);
});

test("flutter: service detection, import graph with cycles", () => {
  const d = flutterApp();
  const sv = findServices(d);
  assert.deepEqual(sv.map((s) => [s.lang, s.kind, s.name]), [["flutter", "mobile", "shop"]]);
  const g = moduleGraph(d, sv[0]);
  assert.deepEqual(Object.keys(g.nodes).sort(), ["(root)", "data", "features/cart"]);
  assert.deepEqual(g.cycles, [["data", "features/cart"]]);
});

test("flutter: structure and security findings", () => {
  const r = checkStructure(flutterApp());
  assert.ok(find(r, /several state-management approaches \(BLoC, Provider\)|several state-management approaches \(Provider, BLoC\)/).length);
  assert.ok(find(r, /layer violation: data\/domain code imports UI code/, "error").length);
  assert.ok(find(r, /SharedPreferences \(plain text\)/, "error").length);
  assert.ok(find(r, /cleartext http/, "warn").length >= 1);
  assert.ok(find(r, /TLS certificate check disabled/, "error").length);
  assert.ok(find(r, /hardcoded key\/secret/, "error").length);
  assert.ok(findings(r).every((f) => f.file.startsWith("mobile")));
});
const findings = (r) => r.findings;

test("python docker scaffold is non-root, has healthcheck, and passes lint; flutter is skipped", () => {
  const d = tmp();
  W(d, "api/requirements.txt", "fastapi\nuvicorn\n"); W(d, "api/main.py", "");
  W(d, "mobile/pubspec.yaml", "name: m\ndependencies:\n  flutter:\n    sdk: flutter\n");
  const r = dockerInit(d);
  assert.ok(r.created.includes("api/Dockerfile")); assert.ok(!r.created.some((f) => f.startsWith("mobile")));
  const df = fs.readFileSync(path.join(d, "api/Dockerfile"), "utf8");
  assert.match(df, /python:3\.12-slim/); assert.match(df, /USER appuser/); assert.match(df, /uvicorn/);
  assert.deepEqual(lintDocker(d).findings, []);
});

test("gate blocks on audit errors; init enables the checks for backends/mobile", () => {
  const d = express();
  W(d, "package.json", JSON.stringify({ name: "root", scripts: { test: 'node -e "process.exit(0)"' } }));
  generate({ tool: "cursor", workflow: "full", specialists: ["backend", "python", "flutter"] }, d);
  const cfg = JSON.parse(fs.readFileSync(path.join(d, ".ai/config.json"), "utf8"));
  assert.equal(cfg.apiCheck, true); assert.equal(cfg.dbCheck, true); assert.equal(cfg.structureCheck, true);
  const g = runGate(d);
  assert.equal(g.passed, false);
  for (const n of ["API Security", "DB Safety"]) assert.equal(g.results.find((x) => x.name === n).status, "FAIL");
  assert.ok(fs.existsSync(path.join(d, ".ai/api-map.md")) && fs.existsSync(path.join(d, ".ai/db-map.md")));
  assert.match(fs.readFileSync(path.join(d, ".ai/api-map.md"), "utf8"), /\| DELETE \| `\/api\/admin\/users\/:id` \| NO \|/);
  assert.ok(fs.existsSync(path.join(d, ".cursor/rules/python.mdc")) && fs.existsSync(path.join(d, ".cursor/rules/flutter.mdc")));
  cfg.apiCheck = false; cfg.dbCheck = false; cfg.structureCheck = false;
  fs.writeFileSync(path.join(d, ".ai/config.json"), JSON.stringify(cfg));
  assert.equal(runGate(d).passed, true);
});

test("all prompts (incl. python, flutter) lint clean", () => assert.deepEqual(lintPrompts(), []));
