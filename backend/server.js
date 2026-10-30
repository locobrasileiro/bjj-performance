import express from 'express';
import Database from 'better-sqlite3';
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = +process.env.PORT || 3000;
const DB_PATH = process.env.DB_PATH || path.join(here, 'data', 'bjj.db');
const EX_PATH = process.env.EXERCISES_PATH || path.join(here, 'exercises.slim.json');
const SECURE = process.env.COOKIE_SECURE === '1';
const DAY = 864e5, SESSION_DAYS = 30;

fs.mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = new Database(DB_PATH);
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');
db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT UNIQUE NOT NULL, name TEXT NOT NULL,
  pass TEXT NOT NULL, role TEXT NOT NULL DEFAULT 'user', created_at TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS sessions (
  token_hash TEXT PRIMARY KEY, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, expires_at INTEGER NOT NULL);
CREATE TABLE IF NOT EXISTS invites (
  id INTEGER PRIMARY KEY AUTOINCREMENT, token_hash TEXT UNIQUE NOT NULL, note TEXT NOT NULL DEFAULT '',
  created_by INTEGER NOT NULL, created_at TEXT NOT NULL, expires_at TEXT NOT NULL,
  used_by INTEGER, used_at TEXT, revoked INTEGER NOT NULL DEFAULT 0);
CREATE TABLE IF NOT EXISTS athlete_docs (
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, id TEXT NOT NULL,
  name TEXT NOT NULL DEFAULT '', data TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL,
  PRIMARY KEY (owner_id, id));
`);

// Migración: columnas nuevas de usuarios
const ucols = db.prepare('PRAGMA table_info(users)').all().map((c) => c.name);
for (const [c, t] of [['username', 'TEXT'], ['photo', 'TEXT'], ['photo_v', 'INTEGER'], ['belt', "TEXT NOT NULL DEFAULT 'Blanca'"], ['stripes', 'INTEGER NOT NULL DEFAULT 0']])
  if (!ucols.includes(c)) db.exec(`ALTER TABLE users ADD COLUMN ${c} ${t}`);
db.exec('CREATE UNIQUE INDEX IF NOT EXISTS users_username ON users(username)');
for (const u of db.prepare('SELECT id, email FROM users WHERE username IS NULL').all()) {
  const base = u.email.split('@')[0].toLowerCase().replace(/[^a-z0-9_.]/g, '').slice(0, 16) || 'user';
  let n = base, i = 1;
  while (db.prepare('SELECT 1 FROM users WHERE username = ?').get(n)) n = base + i++;
  db.prepare('UPDATE users SET username = ? WHERE id = ?').run(n, u.id);
}
db.exec(`
CREATE TABLE IF NOT EXISTS follows (
  follower INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, followee INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, PRIMARY KEY (follower, followee));
CREATE TABLE IF NOT EXISTS posts (
  id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL, text TEXT NOT NULL DEFAULT '', data TEXT NOT NULL);
CREATE TABLE IF NOT EXISTS likes (
  post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE, user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  PRIMARY KEY (post_id, user_id));
CREATE TABLE IF NOT EXISTS comments (
  id INTEGER PRIMARY KEY AUTOINCREMENT, post_id INTEGER NOT NULL REFERENCES posts(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE, text TEXT NOT NULL, created_at TEXT NOT NULL);
`);

const BELTS = ['Blanca', 'Azul', 'Púrpura', 'Marrón', 'Negra'];
const GOALS = ['Fuerza máxima', 'Potencia', 'Hipertrofia', 'Resistencia muscular', 'Pérdida de grasa', 'Preparar campeonato'];
const PHOTO_RE = /^data:image\/(jpeg|png|webp);base64,[A-Za-z0-9+/=]+$/;
const USERNAME_RE = /^[a-z0-9_.]{3,20}$/;
const today = () => new Date().toISOString().slice(0, 10);
const ageOf = (b) => {
  if (!b) return '';
  const d = new Date(b), t = new Date();
  let a = t.getFullYear() - d.getFullYear();
  if (t < new Date(t.getFullYear(), d.getMonth(), d.getDate())) a--;
  return a;
};
function cleanAthlete(a = {}) {
  const belt = BELTS.includes(a.belt) ? a.belt : 'Blanca';
  const birth = /^\d{4}-\d{2}-\d{2}$/.test(a.birth || '') && new Date(a.birth) < new Date() && new Date(a.birth).getFullYear() > 1920 ? a.birth : '';
  const h = +a.h, kg = +a.kg;
  if (!(h >= 100 && h <= 250)) throw E(400, 'Estatura inválida (100 a 250 cm)');
  if (!(kg >= 30 && kg <= 300)) throw E(400, 'Peso inválido (30 a 300 kg)');
  return {
    sex: ['Masculino', 'Femenino'].includes(a.sex) ? a.sex : 'Masculino', belt,
    stripes: Math.min(belt === 'Negra' ? 6 : 4, Math.max(0, parseInt(a.stripes) || 0)),
    goal: GOALS.includes(a.goal) ? a.goal : 'Fuerza máxima', days: Math.min(6, Math.max(1, parseInt(a.days) || 3)), birth, h, kg,
  };
}
function athleteDoc(name, a) {
  const age = ageOf(a.birth);
  return {
    p: { name, sex: a.sex, start: today(), fmin: 5, fights: 6, belt: a.belt, stripes: a.stripes, birth: a.birth, years: '', goal: a.goal, days: a.days, injuries: '', photo: '' },
    ini: { date: today(), age, h: a.h, kg: a.kg, neck: '', abd: '', hip: '', bf: '' },
    fin: { date: '', age, h: a.h, kg: '', neck: '', abd: '', hip: '', bf: '' },
  };
}

const sha = (s) => crypto.createHash('sha256').update(s).digest('hex');
const E = (status, message) => Object.assign(new Error(message), { status });
const hashPw = (pw) => { const s = crypto.randomBytes(16); return s.toString('hex') + ':' + crypto.scryptSync(pw, s, 64).toString('hex'); };
const verifyPw = (pw, stored) => {
  const [s, k] = String(stored).split(':');
  const a = crypto.scryptSync(pw, Buffer.from(s || '00', 'hex'), 64), b = Buffer.from(k || '', 'hex');
  return a.length === b.length && crypto.timingSafeEqual(a, b);
};
const DUMMY = hashPw('dummy-password');

const q = {
  userByEmail: db.prepare('SELECT * FROM users WHERE email = ?'),
  userByLogin: db.prepare('SELECT * FROM users WHERE email = ? OR username = ?'),
  userByName: db.prepare('SELECT 1 FROM users WHERE username = ?'),
  userById: db.prepare('SELECT id, username, name, belt, stripes, photo_v FROM users WHERE id = ?'),
  userPhoto: db.prepare('SELECT photo FROM users WHERE id = ?'),
  userSync: db.prepare("UPDATE users SET name = COALESCE(NULLIF(?, ''), name), belt = ?, stripes = ?, photo = ?, photo_v = ? WHERE id = ?"),
  search: db.prepare(`SELECT u.id, u.username, u.name, u.belt, u.stripes, u.photo_v,
      EXISTS (SELECT 1 FROM follows f WHERE f.follower = @me AND f.followee = u.id) AS following
      FROM users u WHERE u.id <> @me AND (u.username LIKE @like ESCAPE '\\' OR lower(u.name) LIKE @like ESCAPE '\\')
      ORDER BY (u.username = @exact) DESC, u.username LIMIT 20`),
  follows: db.prepare('SELECT 1 FROM follows WHERE follower = ? AND followee = ?'),
  follow: db.prepare('INSERT OR IGNORE INTO follows VALUES (?,?,?)'),
  unfollow: db.prepare('DELETE FROM follows WHERE follower = ? AND followee = ?'),
  nFollowers: db.prepare('SELECT COUNT(*) n FROM follows WHERE followee = ?'),
  nFollowing: db.prepare('SELECT COUNT(*) n FROM follows WHERE follower = ?'),
  nPosts: db.prepare('SELECT COUNT(*) n FROM posts WHERE user_id = ?'),
  addPost: db.prepare('INSERT INTO posts (user_id, created_at, text, data) VALUES (?,?,?,?)'),
  getPost: db.prepare('SELECT id, user_id FROM posts WHERE id = ?'),
  delPost: db.prepare('DELETE FROM posts WHERE id = ? AND user_id = ?'),
  feed: db.prepare(`SELECT p.id, p.user_id, p.created_at, p.text, p.data, u.username, u.name, u.belt, u.stripes, u.photo_v
      FROM posts p JOIN users u ON u.id = p.user_id
      WHERE (p.user_id = @me OR p.user_id IN (SELECT followee FROM follows WHERE follower = @me)) AND p.id < @before
      ORDER BY p.id DESC LIMIT 30`),
  userPosts: db.prepare(`SELECT p.id, p.user_id, p.created_at, p.text, p.data, u.username, u.name, u.belt, u.stripes, u.photo_v
      FROM posts p JOIN users u ON u.id = p.user_id WHERE p.user_id = ? ORDER BY p.id DESC LIMIT 30`),
  nLikes: db.prepare('SELECT COUNT(*) n FROM likes WHERE post_id = ?'),
  liked: db.prepare('SELECT 1 FROM likes WHERE post_id = ? AND user_id = ?'),
  like: db.prepare('INSERT OR IGNORE INTO likes VALUES (?,?)'),
  unlike: db.prepare('DELETE FROM likes WHERE post_id = ? AND user_id = ?'),
  comments: db.prepare(`SELECT c.id, c.text, c.created_at, c.user_id, u.username, u.name, u.belt, u.stripes, u.photo_v
      FROM comments c JOIN users u ON u.id = c.user_id WHERE c.post_id = ? ORDER BY c.id LIMIT 100`),
  addComment: db.prepare('INSERT INTO comments (post_id, user_id, text, created_at) VALUES (?,?,?,?)'),
  getComment: db.prepare('SELECT c.id, c.user_id, p.user_id AS post_owner FROM comments c JOIN posts p ON p.id = c.post_id WHERE c.id = ?'),
  delComment: db.prepare('DELETE FROM comments WHERE id = ?'),
  addAthlete: db.prepare('INSERT INTO athlete_docs (owner_id, id, name, data, created_at, updated_at) VALUES (?,?,?,?,?,?)'),
  inviteInfo: db.prepare('SELECT i.*, u.name AS inviter FROM invites i JOIN users u ON u.id = i.created_by WHERE i.token_hash = ?'),
  userCount: db.prepare('SELECT COUNT(*) n FROM users'),
  addUser: db.prepare('INSERT INTO users (email, name, pass, role, created_at, username) VALUES (?,?,?,?,?,?)'),
  addSession: db.prepare('INSERT INTO sessions VALUES (?,?,?)'),
  session: db.prepare(`SELECT u.id, u.username, u.name, u.email, u.role, u.belt, u.stripes, u.photo_v FROM sessions s JOIN users u ON u.id = s.user_id
                       WHERE s.token_hash = ? AND s.expires_at > ?`),
  delSession: db.prepare('DELETE FROM sessions WHERE token_hash = ?'),
  cleanSessions: db.prepare('DELETE FROM sessions WHERE expires_at < ?'),
  inviteByHash: db.prepare('SELECT * FROM invites WHERE token_hash = ?'),
  addInvite: db.prepare('INSERT INTO invites (token_hash, note, created_by, created_at, expires_at) VALUES (?,?,?,?,?)'),
  useInvite: db.prepare('UPDATE invites SET used_by = ?, used_at = ? WHERE id = ?'),
  listInvites: db.prepare(`SELECT i.id, i.note, i.created_at, i.expires_at, i.used_at, i.revoked, u.name AS used_name
                           FROM invites i LEFT JOIN users u ON u.id = i.used_by ORDER BY i.id DESC LIMIT 100`),
  delInvite: db.prepare('DELETE FROM invites WHERE id = ? AND used_by IS NULL'),
  aList: db.prepare('SELECT id, name, data, updated_at FROM athlete_docs WHERE owner_id = ? ORDER BY created_at'),
  aGet: db.prepare('SELECT id, name, data, updated_at FROM athlete_docs WHERE owner_id = ? AND id = ?'),
  aUp: db.prepare(`INSERT INTO athlete_docs (owner_id, id, name, data, created_at, updated_at) VALUES (@o,@id,@name,@data,@now,@now)
                   ON CONFLICT(owner_id, id) DO UPDATE SET name = @name, data = @data, updated_at = @now`),
  aDel: db.prepare('DELETE FROM athlete_docs WHERE owner_id = ? AND id = ?'),
};
q.cleanSessions.run(Date.now());
setInterval(() => q.cleanSessions.run(Date.now()), 36e5).unref();

// Administrador inicial
if (q.userCount.get().n === 0) {
  const email = (process.env.ADMIN_EMAIL || 'admin@bjj.local').toLowerCase();
  const generated = !process.env.ADMIN_PASSWORD;
  const pw = process.env.ADMIN_PASSWORD || crypto.randomBytes(9).toString('base64url');
  q.addUser.run(email, 'Administrador', hashPw(pw), 'admin', new Date().toISOString(), (process.env.ADMIN_USERNAME || 'admin').toLowerCase());
  console.log(`Administrador creado: ${email}` + (generated ? ` | contraseña generada: ${pw}  (cámbiala definiendo ADMIN_PASSWORD antes del primer arranque)` : ''));
}

const cookie = (req, n) => {
  const m = (req.headers.cookie || '').split(';').map((s) => s.trim()).find((s) => s.startsWith(n + '='));
  return m ? decodeURIComponent(m.slice(n.length + 1)) : null;
};
const setSid = (res, token, maxAge) =>
  res.setHeader('Set-Cookie', `sid=${token}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${maxAge}${SECURE ? '; Secure' : ''}`);
const startSession = (res, userId) => {
  const t = crypto.randomBytes(32).toString('base64url');
  q.addSession.run(sha(t), userId, Date.now() + SESSION_DAYS * DAY);
  setSid(res, t, SESSION_DAYS * 86400);
};
const userPub = (u) => ({ id: u.id, username: u.username, name: u.name, email: u.email, role: u.role, belt: u.belt, stripes: u.stripes, photo_v: u.photo_v });
const pubU = (r) => ({ id: r.user_id ?? r.id, username: r.username, name: r.name, belt: r.belt, stripes: r.stripes, photo_v: r.photo_v });
const needAuth = (req, _res, next) => (req.user ? next() : next(E(401, 'No autenticado')));
const needAdmin = (req, _res, next) => (req.user?.role === 'admin' ? next() : next(E(403, 'Solo administradores')));

const tries = new Map();
const tooMany = (key) => {
  const now = Date.now(), r = tries.get(key);
  if (!r || now - r.t > 6e5) { tries.set(key, { n: 1, t: now }); return false; }
  return ++r.n > 8;
};

const app = express();
app.disable('x-powered-by');
app.set('trust proxy', 1);
app.use(express.json({ limit: '2mb' }));
app.use((req, _res, next) => {
  const t = cookie(req, 'sid');
  if (t) { const u = q.session.get(sha(t), Date.now()); if (u) req.user = u; }
  next();
});
app.use((req, _res, next) => {
  if (!['GET', 'HEAD', 'OPTIONS'].includes(req.method) && req.get('x-requested-with') !== 'bjj') return next(E(403, 'Solicitud no permitida'));
  next();
});

app.get('/api/health', (_req, res) => res.json({ ok: true }));

// ---- Autenticación ----
app.post('/api/auth/login', (req, res) => {
  const email = String(req.body?.login ?? req.body?.email ?? '').trim().toLowerCase().replace(/^@/, ''), pw = String(req.body?.password || '');
  if (tooMany(req.ip + '|' + email)) throw E(429, 'Demasiados intentos. Espera unos minutos.');
  const u = q.userByLogin.get(email, email);
  const ok = verifyPw(pw, u ? u.pass : DUMMY) && !!u;
  if (!ok) throw E(401, 'Correo o contraseña incorrectos');
  startSession(res, u.id);
  res.json(userPub(u));
});
app.post('/api/auth/logout', (req, res) => {
  const t = cookie(req, 'sid'); if (t) q.delSession.run(sha(t));
  setSid(res, '', 0); res.status(204).end();
});
app.get('/api/auth/me', needAuth, (req, res) => res.json(userPub(req.user)));

const validInvite = (token) => {
  const i = q.inviteByHash.get(sha(String(token || '')));
  return i && !i.revoked && !i.used_by && new Date(i.expires_at) > new Date() ? i : null;
};
app.get('/api/auth/invite/:token', (req, res) => {
  if (!validInvite(req.params.token)) throw E(404, 'Invitación inválida, usada o vencida');
  const i = q.inviteInfo.get(sha(req.params.token));
  res.json({ valid: true, inviter: i.inviter, note: i.note });
});
app.post('/api/auth/register', (req, res) => {
  const { token, name, username, email, password, athlete } = req.body || {};
  const em = String(email || '').trim().toLowerCase(), nm = String(name || '').trim(), un = String(username || '').trim().toLowerCase().replace(/^@/, '');
  if (nm.length < 1 || nm.length > 80) throw E(400, 'Escribe tu nombre');
  if (!USERNAME_RE.test(un)) throw E(400, 'El usuario debe tener de 3 a 20 caracteres: letras minúsculas, números, punto o guion bajo');
  if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(em) || em.length > 120) throw E(400, 'Correo inválido');
  if (typeof password !== 'string' || password.length < 8 || password.length > 200) throw E(400, 'La contraseña debe tener al menos 8 caracteres');
  const ath = cleanAthlete(athlete);
  const id = db.transaction(() => {
    const inv = validInvite(token);
    if (!inv) throw E(400, 'Invitación inválida, usada o vencida');
    if (q.userByEmail.get(em)) throw E(409, 'Ese correo ya está registrado');
    if (q.userByName.get(un)) throw E(409, 'Ese usuario ya existe, elige otro');
    const now = new Date().toISOString();
    const uid = q.addUser.run(em, nm, hashPw(password), 'user', now, un).lastInsertRowid;
    db.prepare('UPDATE users SET belt = ?, stripes = ? WHERE id = ?').run(ath.belt, ath.stripes, uid);
    q.addAthlete.run(uid, 'a1', nm, JSON.stringify(athleteDoc(nm, ath)), now, now);
    q.useInvite.run(uid, now, inv.id);
    return uid;
  })();
  startSession(res, id);
  res.status(201).json(userPub({ ...q.userById.get(id), email: em, role: 'user' }));
});

// ---- Invitaciones (solo admin) ----
app.post('/api/invites', needAuth, needAdmin, (req, res) => {
  const days = Math.min(30, Math.max(1, +req.body?.days || 7));
  const token = crypto.randomBytes(24).toString('base64url');
  const exp = new Date(Date.now() + days * DAY).toISOString();
  q.addInvite.run(sha(token), String(req.body?.note || '').slice(0, 80), req.user.id, new Date().toISOString(), exp);
  res.status(201).json({ token, expires_at: exp });
});
app.get('/api/invites', needAuth, needAdmin, (_req, res) => {
  const now = new Date();
  res.json(q.listInvites.all().map((i) => ({
    ...i, revoked: undefined,
    status: i.used_at ? 'usada' : i.revoked ? 'revocada' : new Date(i.expires_at) < now ? 'vencida' : 'pendiente',
  })));
});
app.delete('/api/invites/:id', needAuth, needAdmin, (req, res) => {
  if (!q.delInvite.run(+req.params.id).changes) throw E(404, 'Invitación no encontrada o ya usada');
  res.status(204).end();
});

// ---- Ejercicios y atletas (cada usuario solo ve los suyos) ----
let exercises = '[]';
try { exercises = fs.readFileSync(EX_PATH, 'utf8'); } catch { console.warn('Sin catálogo de ejercicios en', EX_PATH); }
app.get('/api/exercises', needAuth, (_req, res) => res.type('json').set('Cache-Control', 'private, max-age=86400').send(exercises));

const ID = /^[A-Za-z0-9_-]{1,40}$/;
const pub = (r, full) => ({ id: r.id, name: r.name, updated_at: r.updated_at, ...(full ? { data: JSON.parse(r.data) } : {}) });
app.get('/api/athletes', needAuth, (req, res) => res.json(q.aList.all(req.user.id).map((r) => pub(r, req.query.full === '1'))));
app.get('/api/athletes/:id', needAuth, (req, res) => {
  const r = q.aGet.get(req.user.id, req.params.id);
  if (!r) throw E(404, 'Atleta no encontrado');
  res.json(pub(r, true));
});
app.put('/api/athletes/:id', needAuth, (req, res) => {
  const { id } = req.params, b = req.body;
  if (!ID.test(id)) throw E(400, 'id inválido');
  if (!b || typeof b !== 'object' || Array.isArray(b) || typeof b.p !== 'object' || b.p === null) throw E(400, 'Cuerpo inválido: se espera el objeto del atleta con "p"');
  const p = b.p, cur = q.userPhoto.get(req.user.id) || {}, st = db.prepare('SELECT photo_v FROM users WHERE id = ?').get(req.user.id);
  const belt = BELTS.includes(p.belt) ? p.belt : 'Blanca', stripes = Math.min(belt === 'Negra' ? 6 : 4, Math.max(0, parseInt(p.stripes) || 0));
  let photo = cur.photo ?? null, pv = st?.photo_v ?? null;
  if (p.photo === '') { photo = null; pv = null; }
  else if (typeof p.photo === 'string' && p.photo !== photo && p.photo.length < 250000 && PHOTO_RE.test(p.photo)) { photo = p.photo; pv = Date.now(); }
  q.userSync.run(String(p.name ?? '').trim().slice(0, 80), belt, stripes, photo, pv, req.user.id);
  q.aUp.run({ o: req.user.id, id, name: String(b.p.name ?? '').slice(0, 120), data: JSON.stringify(b), now: new Date().toISOString() });
  res.json(pub(q.aGet.get(req.user.id, id), false));
});
app.delete('/api/athletes/:id', needAuth, (req, res) => {
  if (!q.aDel.run(req.user.id, req.params.id).changes) throw E(404, 'Atleta no encontrado');
  res.status(204).end();
});

// ---- Comunidad: usuarios, seguir, publicaciones, me gusta y comentarios ----
const canSee = (me, owner) => me === owner || !!q.follows.get(me, owner);
const hyd = (rows, me) => rows.map((r) => ({
  id: r.id, created_at: r.created_at, text: r.text, data: JSON.parse(r.data), user: pubU(r),
  likes: q.nLikes.get(r.id).n, liked: !!q.liked.get(r.id, me),
  comments: q.comments.all(r.id).map((c) => ({ id: c.id, text: c.text, created_at: c.created_at, user: pubU(c) })),
}));
const postOr404 = (id) => { const p = q.getPost.get(+id); if (!p) throw E(404, 'Publicación no encontrada'); return p; };

app.get('/api/users', needAuth, (req, res) => {
  const s = String(req.query.q || '').trim().toLowerCase().replace(/^@/, '');
  if (s.length < 2) return res.json([]);
  const like = '%' + s.replace(/[\\%_]/g, '\\$&') + '%';
  res.json(q.search.all({ me: req.user.id, like, exact: s }).map((u) => ({ ...pubU(u), following: !!u.following })));
});
app.get('/api/users/:id/photo', needAuth, (req, res) => {
  const m = /^data:(image\/\w+);base64,(.*)$/.exec(q.userPhoto.get(+req.params.id)?.photo || '');
  if (!m) throw E(404, 'Sin foto');
  res.type(m[1]).set('Cache-Control', 'private, max-age=86400').send(Buffer.from(m[2], 'base64'));
});
app.get('/api/users/:id', needAuth, (req, res) => {
  const u = q.userById.get(+req.params.id);
  if (!u) throw E(404, 'Usuario no encontrado');
  const me = req.user.id, following = !!q.follows.get(me, u.id), visible = canSee(me, u.id);
  res.json({ ...pubU(u), is_me: me === u.id, is_following: following, followers: q.nFollowers.get(u.id).n,
    following_count: q.nFollowing.get(u.id).n, posts_count: q.nPosts.get(u.id).n,
    posts: visible ? hyd(q.userPosts.all(u.id), me) : [] });
});
app.post('/api/users/:id/follow', needAuth, (req, res) => {
  const id = +req.params.id;
  if (id === req.user.id) throw E(400, 'No puedes seguirte a ti mismo');
  if (!q.userById.get(id)) throw E(404, 'Usuario no encontrado');
  q.follow.run(req.user.id, id, new Date().toISOString());
  res.json({ following: true });
});
app.delete('/api/users/:id/follow', needAuth, (req, res) => { q.unfollow.run(req.user.id, +req.params.id); res.json({ following: false }); });

app.get('/api/feed', needAuth, (req, res) => {
  const before = +req.query.before > 0 ? +req.query.before : Number.MAX_SAFE_INTEGER;
  res.json(hyd(q.feed.all({ me: req.user.id, before }), req.user.id));
});
app.post('/api/posts', needAuth, (req, res) => {
  const { text, data } = req.body || {};
  if (!data || typeof data !== 'object' || Array.isArray(data) || data.kind !== 'workout') throw E(400, 'Datos de entrenamiento inválidos');
  const json = JSON.stringify(data);
  if (json.length > 20000) throw E(400, 'Publicación demasiado grande');
  const id = q.addPost.run(req.user.id, new Date().toISOString(), String(text || '').trim().slice(0, 500), json).lastInsertRowid;
  res.status(201).json({ id });
});
app.delete('/api/posts/:id', needAuth, (req, res) => {
  if (!q.delPost.run(+req.params.id, req.user.id).changes) throw E(404, 'Publicación no encontrada');
  res.status(204).end();
});
app.post('/api/posts/:id/like', needAuth, (req, res) => {
  const p = postOr404(req.params.id);
  if (!canSee(req.user.id, p.user_id)) throw E(403, 'Sigue a este usuario para interactuar');
  if (q.liked.get(p.id, req.user.id)) q.unlike.run(p.id, req.user.id); else q.like.run(p.id, req.user.id);
  res.json({ liked: !!q.liked.get(p.id, req.user.id), likes: q.nLikes.get(p.id).n });
});
app.post('/api/posts/:id/comments', needAuth, (req, res) => {
  const p = postOr404(req.params.id);
  if (!canSee(req.user.id, p.user_id)) throw E(403, 'Sigue a este usuario para interactuar');
  const text = String(req.body?.text || '').trim().slice(0, 300);
  if (!text) throw E(400, 'Escribe un comentario');
  const now = new Date().toISOString(), id = q.addComment.run(p.id, req.user.id, text, now).lastInsertRowid;
  res.status(201).json({ id, text, created_at: now, user: pubU(q.userById.get(req.user.id)) });
});
app.delete('/api/comments/:id', needAuth, (req, res) => {
  const c = q.getComment.get(+req.params.id);
  if (!c) throw E(404, 'Comentario no encontrado');
  if (c.user_id !== req.user.id && c.post_owner !== req.user.id) throw E(403, 'No permitido');
  q.delComment.run(c.id);
  res.status(204).end();
});

app.use((err, _req, res, _next) => res.status(err.status || 500).json({ error: err.status ? err.message : 'Error interno' }));
app.listen(PORT, () => console.log(`API escuchando en :${PORT} (db: ${DB_PATH})`));
