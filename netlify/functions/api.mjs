// API ISA Conseils : lecture publique des données, écriture réservée aux administrateurs.
// Stockage : Neon (PostgreSQL). Variables d'environnement Netlify :
//   DATABASE_URL (ou NETLIFY_DATABASE_URL) : chaîne de connexion Neon
//   ADMIN_INITIAL_PASSWORD : mot de passe du premier compte « admin » (utilisé une seule fois)
import { neon } from "@neondatabase/serverless";
import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

export const config = { path: "/api/*" };

const SESSION_DAYS = 7;
let sqlClient = null;
let schemaReady = null;

function db() {
  const url = process.env.DATABASE_URL || process.env.NETLIFY_DATABASE_URL;
  if (!url) throw new HttpError(500, "Base de données non configurée (DATABASE_URL manquant).");
  if (!sqlClient) sqlClient = neon(url);
  return sqlClient;
}

async function ensureSchema() {
  if (!schemaReady) {
    const sql = db();
    schemaReady = (async () => {
      await sql`CREATE TABLE IF NOT EXISTS site_data (
        id integer PRIMARY KEY, data jsonb NOT NULL,
        updated_at timestamptz NOT NULL DEFAULT now(), updated_by text)`;
      await sql`CREATE TABLE IF NOT EXISTS admins (
        username text PRIMARY KEY, hash text NOT NULL, salt text NOT NULL,
        must_change boolean NOT NULL DEFAULT false, created_at timestamptz NOT NULL DEFAULT now())`;
      await sql`CREATE TABLE IF NOT EXISTS sessions (
        token text PRIMARY KEY, username text NOT NULL REFERENCES admins(username) ON DELETE CASCADE,
        expires_at timestamptz NOT NULL)`;
    })().catch((e) => { schemaReady = null; throw e; });
  }
  return schemaReady;
}

class HttpError extends Error {
  constructor(status, message) { super(message); this.status = status; }
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" },
  });

function hashPassword(password, salt = randomBytes(16).toString("hex")) {
  return { salt, hash: scryptSync(password, salt, 64).toString("hex") };
}
function checkPassword(password, salt, hash) {
  const a = Buffer.from(hashPassword(password, salt).hash, "hex");
  const b = Buffer.from(hash, "hex");
  return a.length === b.length && timingSafeEqual(a, b);
}
function validUser(u) { return typeof u === "string" && /^[a-z0-9._-]{2,40}$/.test(u); }
function validPassword(p) { return typeof p === "string" && p.length >= 8 && p.length <= 200; }
const pause = (ms) => new Promise((r) => setTimeout(r, ms));

async function requireAdmin(req) {
  const m = (req.headers.get("authorization") || "").match(/^Bearer\s+([a-f0-9]{64})$/i);
  if (!m) throw new HttpError(401, "Connexion requise.");
  const sql = db();
  const rows = await sql`SELECT username FROM sessions WHERE token = ${m[1]} AND expires_at > now()`;
  if (!rows.length) throw new HttpError(401, "Session expirée, reconnectez-vous.");
  return { user: rows[0].username, token: m[1] };
}

async function body(req) {
  try { return await req.json(); } catch { throw new HttpError(400, "Requête invalide."); }
}

async function route(req) {
  const url = new URL(req.url);
  const path = url.pathname.replace(/^\/api\/?/, "").replace(/\/+$/, "");
  const method = req.method;
  await ensureSchema();
  const sql = db();

  // ----- public : version et données du site
  if (path === "data" && method === "GET") {
    const rows = await sql`SELECT data, updated_at FROM site_data WHERE id = 1`;
    if (!rows.length) return json({ data: null, updatedAt: null });
    const updatedAt = new Date(rows[0].updated_at).toISOString();
    if (url.searchParams.get("since") === updatedAt) return json({ unchanged: true, updatedAt });
    return json({ data: rows[0].data, updatedAt });
  }
  if (path === "version" && method === "GET") {
    const rows = await sql`SELECT updated_at FROM site_data WHERE id = 1`;
    return json({ updatedAt: rows.length ? new Date(rows[0].updated_at).toISOString() : null });
  }

  // ----- connexion
  if (path === "login" && method === "POST") {
    const { user, password } = await body(req);
    const u = String(user || "").trim().toLowerCase();
    let rows = await sql`SELECT username, hash, salt, must_change FROM admins WHERE username = ${u}`;
    if (!rows.length) {
      // Premier démarrage : aucun administrateur → création du compte « admin » avec ADMIN_INITIAL_PASSWORD
      const count = await sql`SELECT count(*)::int AS n FROM admins`;
      const initial = process.env.ADMIN_INITIAL_PASSWORD;
      if (count[0].n === 0 && u === "admin" && initial && password === initial) {
        const h = hashPassword(password);
        await sql`INSERT INTO admins (username, hash, salt, must_change) VALUES ('admin', ${h.hash}, ${h.salt}, true)
                  ON CONFLICT (username) DO NOTHING`;
        rows = await sql`SELECT username, hash, salt, must_change FROM admins WHERE username = 'admin'`;
      }
    }
    if (!rows.length || !checkPassword(String(password || ""), rows[0].salt, rows[0].hash)) {
      await pause(700);
      throw new HttpError(401, "Identifiant ou mot de passe incorrect.");
    }
    const token = randomBytes(32).toString("hex");
    await sql`DELETE FROM sessions WHERE expires_at < now()`;
    await sql`INSERT INTO sessions (token, username, expires_at)
              VALUES (${token}, ${u}, now() + make_interval(days => ${SESSION_DAYS}))`;
    return json({ token, user: u, mustChange: rows[0].must_change });
  }

  // ----- tout ce qui suit exige une session administrateur
  const me = await requireAdmin(req);

  if (path === "me" && method === "GET") return json({ user: me.user });

  if (path === "logout" && method === "POST") {
    await sql`DELETE FROM sessions WHERE token = ${me.token}`;
    return json({ ok: true });
  }

  if (path === "data" && method === "PUT") {
    const { data, baseUpdatedAt, force } = await body(req);
    if (!data || typeof data !== "object" || !Array.isArray(data.presentation) || !Array.isArray(data.references))
      throw new HttpError(400, "Données invalides.");
    const cur = await sql`SELECT updated_at, updated_by FROM site_data WHERE id = 1`;
    if (cur.length && !force) {
      const curAt = new Date(cur[0].updated_at).toISOString();
      if (baseUpdatedAt !== curAt)
        return json({ error: "conflict", updatedAt: curAt, updatedBy: cur[0].updated_by }, 409);
    }
    const rows = await sql`
      INSERT INTO site_data (id, data, updated_at, updated_by) VALUES (1, ${JSON.stringify(data)}::jsonb, now(), ${me.user})
      ON CONFLICT (id) DO UPDATE SET data = EXCLUDED.data, updated_at = now(), updated_by = EXCLUDED.updated_by
      RETURNING updated_at`;
    return json({ ok: true, updatedAt: new Date(rows[0].updated_at).toISOString() });
  }

  if (path === "password" && method === "POST") {
    const { password } = await body(req);
    if (!validPassword(password)) throw new HttpError(400, "Le mot de passe doit faire au moins 8 caractères.");
    const h = hashPassword(password);
    await sql`UPDATE admins SET hash = ${h.hash}, salt = ${h.salt}, must_change = false WHERE username = ${me.user}`;
    await sql`DELETE FROM sessions WHERE username = ${me.user} AND token <> ${me.token}`;
    return json({ ok: true });
  }

  if (path === "admins" && method === "GET") {
    const rows = await sql`SELECT username FROM admins ORDER BY created_at`;
    return json({ admins: rows.map((r) => r.username), me: me.user });
  }
  if (path === "admins" && method === "POST") {
    const { user, password } = await body(req);
    const u = String(user || "").trim().toLowerCase();
    if (!validUser(u)) throw new HttpError(400, "Identifiant invalide (lettres, chiffres, . _ -).");
    if (!validPassword(password)) throw new HttpError(400, "Le mot de passe doit faire au moins 8 caractères.");
    const h = hashPassword(password);
    const r = await sql`INSERT INTO admins (username, hash, salt) VALUES (${u}, ${h.hash}, ${h.salt})
                        ON CONFLICT (username) DO NOTHING RETURNING username`;
    if (!r.length) throw new HttpError(409, "Cet identifiant existe déjà.");
    return json({ ok: true });
  }
  const del = path.match(/^admins\/([^/]+)$/);
  if (del && method === "DELETE") {
    const u = decodeURIComponent(del[1]).toLowerCase();
    if (u === me.user) throw new HttpError(400, "Vous ne pouvez pas supprimer votre propre compte.");
    await sql`DELETE FROM admins WHERE username = ${u}`;
    return json({ ok: true });
  }

  throw new HttpError(404, "Ressource inconnue.");
}

export default async (req) => {
  try {
    return await route(req);
  } catch (e) {
    if (e instanceof HttpError) return json({ error: e.message }, e.status);
    console.error(e);
    return json({ error: "Erreur serveur." }, 500);
  }
};
