import fs from "node:fs";
import os from "node:os";
import path from "node:path";
export const W = (d, f, c) => { fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true }); fs.writeFileSync(path.join(d, f), c); };
export const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "afa-"));
export function express() {
  const d = tmp();
  W(d, "server/package.json", JSON.stringify({ name: "server", dependencies: { express: "4", mongoose: "7", jsonwebtoken: "9" } }));
  W(d, "server/src/app.js", `const express = require('express');
const cors = require('cors');
const authRoutes = require('./routes/auth');
const ticketRoutes = require('./routes/tickets');
const adminRoutes = require('./routes/admin');
const { authenticate } = require('./middleware/auth');
const app = express();
app.use(cors());
app.use('/api/auth', authRoutes);
app.use('/api/tickets', authenticate, ticketRoutes);
app.use('/api/admin', adminRoutes);
app.get('/health', (req, res) => res.send('ok'));
`);
  W(d, "server/src/middleware/auth.js", "const jwt = require('jsonwebtoken');\nexports.authenticate = (req,res,next) => { req.user = jwt.verify(req.headers.authorization, process.env.JWT_SECRET); next(); };\nexports.authorize = (...r) => (req,res,next) => next();\n");
  W(d, "server/src/routes/auth.js", `const router = require('express').Router();
const c = require('../controllers/authController');
router.post('/login', c.login);
router.post('/register', rateLimit, validate(schema), c.register);
module.exports = router;
`);
  W(d, "server/src/routes/tickets.js", `const express = require('express');
const router = express.Router();
const t = require('../controllers/ticketController');
router.get('/', t.list);
router.post('/', validate(ticketSchema), t.create);
router.put('/:id', validate(ticketSchema), t.update);
router.route('/:id').delete(t.remove);
module.exports = router;
`);
  W(d, "server/src/routes/admin.js", `const router = require('express').Router();
const u = require('../controllers/userController');
router.get('/users', u.list);
router.delete('/users/:id', u.remove);
module.exports = router;
`);
  W(d, "server/src/controllers/ticketController.js", `const Ticket = require('../models/Ticket');
exports.list = async (req, res) => res.json(await Ticket.find({ owner: req.user.id }));
exports.create = async (req, res) => res.json(await Ticket.create(req.body));
exports.update = async (req, res) => { const t = await Ticket.findById(req.params.id); res.json(t); };
exports.remove = async (req, res) => { const t = await Ticket.findOne({ _id: req.params.id, owner: req.user.id }); res.json(t); };
`);
  W(d, "server/src/controllers/authController.js", "exports.login = async (req,res) => { const u = await User.findOne(req.body); res.json(u); };\nexports.register = async (req,res) => res.json({});\n");
  W(d, "server/src/controllers/userController.js", "exports.list = (req,res)=>res.json([]);\nexports.remove = (req,res)=>res.json({});\n");
  W(d, "server/src/models/Ticket.js", `const mongoose = require('mongoose');
const ticketSchema = new mongoose.Schema({
  title: { type: String, required: true },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  status: { type: String }
});
module.exports = mongoose.model('Ticket', ticketSchema);
`);
  W(d, "server/src/models/User.js", `const mongoose = require('mongoose');
const userSchema = new mongoose.Schema({
  email: { type: String, required: true },
  password: { type: String, required: true },
  role: { type: String, default: 'user' }
}, { timestamps: true });
module.exports = mongoose.model('User', userSchema);
`);
  return d;
}

export function flutterApp() {
  const d = tmp();
  W(d, "mobile/pubspec.yaml", "name: shop\ndependencies:\n  flutter:\n    sdk: flutter\n  provider: ^6.0.0\n  flutter_bloc: ^8.0.0\n  http: ^1.0.0\n");
  W(d, "mobile/lib/main.dart", "import 'package:shop/features/cart/presentation/cart_page.dart';\n");
  W(d, "mobile/lib/features/cart/presentation/cart_page.dart", "import 'package:shop/data/cart_repository.dart';\nimport 'package:http/http.dart' as http;\nfinal api = 'http://api.shop.com/v1';\nvoid f(){ http.get(Uri.parse('http://api.shop.com')); }\n");
  W(d, "mobile/lib/data/cart_repository.dart", `import 'package:shared_preferences/shared_preferences.dart';
import 'package:shop/features/cart/presentation/cart_page.dart';
Future<void> save(String t) async { final p = await SharedPreferences.getInstance(); p.setString('auth_token', t); }
const apiKey = 'sk_live_abcdefghijklmnop1234';
void tls(HttpClient c){ c.badCertificateCallback = (cert, host, port) => true; }
`);
  return d;
}

export function nextApp({ ts = true } = {}) {
  const d = tmp();
  const x = ts ? "ts" : "js", xx = ts ? "tsx" : "jsx";
  W(d, "package.json", JSON.stringify({ name: "shop", scripts: { build: "next build", test: 'node -e "process.exit(0)"' }, dependencies: { next: "14", react: "18", "@prisma/client": "5", "next-auth": "4", zod: "3" }, devDependencies: ts ? { typescript: "5" } : {} }));
  if (ts) W(d, "tsconfig.json", `{
  // comments and trailing commas are legal in tsconfig
  "compilerOptions": {
    "strict": false,
    "baseUrl": ".",
    "paths": { "@/*": ["./src/*"], },
  },
}
`);
  W(d, `src/app/layout.${xx}`, "export default function Root({ children }) { return children; }\n");
  W(d, `src/app/api/tickets/route.${x}`, `import { auth } from '@/lib/auth';
import { z } from 'zod';
import { db } from '@/lib/db';
export async function GET() { return Response.json(await db.ticket.findMany()); }
export async function POST(req) {
  const session = await auth();
  const body = z.object({ title: z.string() }).parse(await req.json());
  return Response.json(await db.ticket.create({ data: body }));
}
`);
  W(d, `src/app/api/tickets/[id]/route.${x}`, `import { auth } from '@/lib/auth';
export async function DELETE(req, { params }) { return Response.json({ ok: true }); }
export async function PUT(req, { params }) {
  const session = await auth();
  return Response.json({ id: params.id });
}
`);
  W(d, `src/app/api/auth/login/route.${x}`, "export async function POST(req) { return Response.json({}); }\n");
  W(d, `src/app/api/admin/users/route.${x}`, "export async function GET() { return Response.json([]); }\n");
  W(d, `src/app/(shop)/cart/page.${xx}`, "export default function Cart() { return null; }\n");
  W(d, `src/middleware.${x}`, `import { getToken } from 'next-auth/jwt';
export async function middleware(req) { const t = await getToken({ req }); }
export const config = { matcher: ['/api/admin/:path*'] };
`);
  W(d, `pages/api/legacy/[id].${x}`, "export default function handler(req, res) {\n  if (req.method === 'DELETE') { return res.json({ ok: true }); }\n  res.json({});\n}\n");
  W(d, `src/actions/ticket.${x}`, `'use server';
import { auth } from '@/lib/auth';
export async function deleteTicket(id) { return { id }; }
export async function createTicket(data) { const s = await auth(); return data; }
`);
  W(d, `src/components/Bad.${xx}`, `'use client';
import { PrismaClient } from '@prisma/client';
export default function Bad() { const k = process.env.DB_PASSWORD; return <div dangerouslySetInnerHTML={{ __html: 'x' }} />; }
`);
  W(d, `src/lib/auth.${x}`, "export const auth = async () => ({ user: { id: '1' } });\n");
  W(d, `src/lib/db.${x}`, "import { helper } from '@/components/Bad';\nexport const db = {};\n");
  W(d, ".env", "NEXT_PUBLIC_API_SECRET=abc123\nNEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY=pk_test_1\nDATABASE_URL=postgres://x\n");
  return d;
}

const rep = (n, f) => Array.from({ length: n }, (_, i) => f(i)).join("\n");

// An Express + Mongoose service with Jest tests, some of them bad on purpose.
export function qualityApp() {
  const d = tmp();
  W(d, "package.json", JSON.stringify({ name: "root", scripts: { test: 'node -e "process.exit(0)"' } }));
  W(d, "server/package.json", JSON.stringify({ name: "server", scripts: { test: "jest", start: "node src/app.js" }, dependencies: { express: "4", mongoose: "7" }, devDependencies: { jest: "29" } }));
  W(d, "server/src/app.js", "const t = require('./controllers/ticketController');\n");
  W(d, "server/src/controllers/ticketController.js", "const Ticket = require('../models/Ticket');\nexports.list = async (req, res) => res.json(await Ticket.find());\nexports.create = async (req, res) => res.json(await Ticket.create(req.body));\n");
  W(d, "server/src/controllers/userController.js", `const User = require('../models/User');\n${rep(160, (i) => `exports.fn${i} = (x) => { return x + ${i}; };`)}\n`);
  W(d, "server/src/services/mailService.js", "exports.send = (to) => ({ to });\nexports.queue = (to) => [to];\n");
  W(d, "server/src/services/priceService.js", "exports.total = (items) => items.reduce((a, b) => a + b, 0);\n");
  W(d, "server/src/utils/format.js", "module.exports = {};\nexports.money = (n) => n.toFixed(2);\n");
  W(d, "server/src/utils/dates.js", "module.exports = { parse: (s) => new Date(s) };\n");
  W(d, "server/src/models/Ticket.js", `const mongoose = require('mongoose');
const ticketSchema = new mongoose.Schema({
  title: { type: String, required: true },
  owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
  watchers: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }]
}, { timestamps: true });
module.exports = mongoose.model('Ticket', ticketSchema);
`);
  W(d, "server/src/models/User.js", "const mongoose = require('mongoose');\nconst userSchema = new mongoose.Schema({ name: { type: String, required: true } }, { timestamps: true });\nmodule.exports = mongoose.model('User', userSchema);\n");
  W(d, "server/tests/ticketController.test.js", "const c = require('../src/controllers/ticketController');\ndescribe('tickets', () => {\n  it('lists', () => { expect(c.list).toBeDefined(); });\n});\n");
  W(d, "server/src/services/mailService.test.js", "const { send } = require('./mailService');\ntest('sends', () => { expect(send('a').to).toBe('a'); });\n");
  W(d, "server/tests/price.test.js", `const { total } = require('../src/services/priceService');
describe('price', () => {
  it.only('adds', () => { expect(total([1, 2])).toBe(3); });
  it.skip('ignores', () => { expect(total([])).toBe(0); });
  it('checks nothing', () => { total([1]); });
  it('is empty', () => {});
});
`);
  W(d, "server/tests/format.test.js", "import { money } from '../src/utils/format';\ntest('money', () => { expect(money(1)).toBe('1.00'); });\n");
  return d;
}
export { rep };

// A classic MERN project: React (Vite) + Express + MongoDB + JWT, written the secure way.
export function mernApp() {
  const d = tmp();
  W(d, "package.json", JSON.stringify({ name: "mern-shop", scripts: { test: 'node -e "process.exit(0)"' } }));
  W(d, "server/package.json", JSON.stringify({ name: "server", scripts: { start: "node src/app.js" }, dependencies: { express: "4", mongoose: "7", jsonwebtoken: "9", helmet: "7" } }));
  W(d, "server/src/app.js", "const express = require('express');\nconst authRoutes = require('./routes/auth');\nconst ticketRoutes = require('./routes/tickets');\nconst app = express();\napp.use(express.json());\napp.use('/api/auth', authRoutes);\napp.use('/api/tickets', ticketRoutes);\nmodule.exports = app;\n");
  W(d, "server/src/routes/auth.js", "const router = require('express').Router();\nconst c = require('../controllers/authController');\nrouter.post('/login', loginLimiter, validateLogin, c.login);\nmodule.exports = router;\n");
  W(d, "server/src/routes/tickets.js", "const router = require('express').Router();\nconst { authenticate } = require('../middleware/auth');\nconst t = require('../controllers/ticketController');\nrouter.use(authenticate);\nrouter.get('/', t.list);\nrouter.post('/', validateTicket, t.create);\nrouter.delete('/:id', t.remove);\nmodule.exports = router;\n");
  W(d, "server/src/middleware/auth.js", "const jwt = require('jsonwebtoken');\nexports.authenticate = (req, res, next) => { req.user = jwt.verify(req.headers.authorization, process.env.JWT_SECRET); next(); };\n");
  W(d, "server/src/controllers/ticketController.js", "const Ticket = require('../models/Ticket');\nexports.list = async (req, res) => res.json(await Ticket.find({ owner: req.user.id }));\nexports.create = async (req, res) => res.json(await Ticket.create({ title: req.body.title, owner: req.user.id }));\nexports.remove = async (req, res) => { const t = await Ticket.findOne({ _id: req.params.id, owner: req.user.id }); res.json(t); };\n");
  W(d, "server/src/controllers/authController.js", "const User = require('../models/User');\nexports.login = async (req, res) => { const u = await User.findOne({ email: String(req.body.email) }); res.json({ ok: !!u }); };\n");
  W(d, "server/src/models/Ticket.js", "const mongoose = require('mongoose');\nconst s = new mongoose.Schema({ title: { type: String, required: true }, owner: { type: mongoose.Schema.Types.ObjectId, ref: 'User', index: true } }, { timestamps: true });\nmodule.exports = mongoose.model('Ticket', s);\n");
  W(d, "server/src/models/User.js", "const mongoose = require('mongoose');\nconst s = new mongoose.Schema({ email: { type: String, required: true, unique: true }, password: { type: String, required: true, select: false }, role: { type: String, enum: ['user', 'admin'], default: 'user' } }, { timestamps: true });\nmodule.exports = mongoose.model('User', s);\n");
  W(d, "server/tests/ticketController.test.js", "const c = require('../src/controllers/ticketController');\ntest('exports list', () => { expect(typeof c.list).toBe('function'); });\n");
  W(d, "client/package.json", JSON.stringify({ name: "client", scripts: { build: "vite build" }, dependencies: { react: "18", axios: "1" }, devDependencies: { vite: "5" } }));
  W(d, "client/src/App.jsx", "import Tickets from './pages/Tickets';\nexport default Tickets;\n");
  W(d, "client/src/pages/Tickets.jsx", "import { api } from '../api/http';\nexport default function Tickets() { api.list(); return null; }\n");
  W(d, "client/src/api/http.js", "import axios from 'axios';\nexport const api = { list: () => axios.get('/api/tickets') };\n");
  return d;
}
