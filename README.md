# ATOM — AVIT Ticketing & Operations Manager

AV/IT help, tickets, service requests and asset tracking for AJSM (Aljamea-tus-Saifiyah).
Runs at **https://marol.jameasaifiyah.edu/Atom** on IIS + iisnode.

Decisions: `ATOM_Decisions.md` (wins on conflict) → `ATOM_Project_Context.md` → `ATOM_Core_Functionalities.pdf`.

## Structure

```
atom/
├─ client/        React + Vite + Tailwind (base /Atom/)
├─ server/        Express 5 + Socket.IO, entry server/server.js (iisnode)
│  ├─ config/     env loading + startup checks
│  ├─ db/         pg pool, migrate.js, migrations/NNN_name.sql
│  ├─ modules/    one folder per feature (health, auth, …)
│  └─ tests/      Jest — no real DB or external services
├─ shared/        roles.json, statuses.json (used by client and server)
├─ sync/          run scripts only (Task Scheduler / one-time import); logic in server/modules/sync
├─ web.config     IIS: handler, rewrites, security (project root only)
└─ .env.example   every setting; copy to .env
```

## Sub-path rule

`/Atom` — exact spelling — in: Vite `base`, Router `basename`, axios `baseURL` (`/Atom/api`),
Socket.IO `path` (`/Atom/socket.io`), service worker scope, manifest `start_url`/`scope`, `BASE_PATH`.
A mismatch = blank page with *"Expected a JavaScript module script…"*.

## Local setup

Prereqs: Node ≥ 20.19, PostgreSQL, Git Bash.

```bash
cp .env.example .env              # fill PG_* at least
(cd server && npm install)
(cd client && npm install)
(cd server && npm run migrate)    # creates schema_migrations + src schema
```

Run (two terminals):

```bash
cd server && npm run dev          # http://localhost:3000
cd client && npm run dev          # http://localhost:5173/Atom/
```

The Vite dev server proxies `/Atom/api` and `/Atom/socket.io` to port 3000.
The home page is a system check: API, Database and Real-time should all show OK.

## Scripts

| Where | Command | Does |
|---|---|---|
| server | `npm run dev` | API with auto-restart |
| server | `npm start` | API (what iisnode runs) |
| server | `npm test` | Jest |
| server | `npm run check` | `node --check` on server files |
| server | `npm run migrate` | apply pending migrations |
| server | `npm run seed:dev` | dev test accounts (refused in production) |
| server | `npm run sync:idarah` | Idarah view → ATOM (`-- --force` overrides the 50% guard) |
| server | `npm run import:employees` | Login_Master dry run (`-- --commit` to save) |
| client | `npm run dev` / `build` / `lint` | Vite dev / production build / ESLint |

## People data (Phase 3)

**Employee-ID users — once:**

```bash
cd server
npm run import:employees               # dry run: counts + errors, nothing saved
npm run import:employees -- --commit   # all rows or nothing; re-running skips existing IDs
```

**Idarah sync — by hand, then every ~10 min by Windows Task Scheduler:**

```bash
cd server && npm run sync:idarah
```

Task Scheduler action: Program `C:\Program Files\nodejs\node.exe`, Arguments `sync\run-idarah-sync.js`,
Start in = the ATOM folder. Exit code 0 = OK / already running, 2 = blocked by the guard, 1 = failed.
Every run is logged in `src.sync_runs` (Super Admin: `GET /Atom/api/sync/runs`, "Sync now": `POST /Atom/api/sync/idarah`).

**Integration tests (real PostgreSQL, SQL Server faked)** — only against a database whose name ends in `_test`:

```bash
createdb atom_test   # or in pgAdmin
TEST_DATABASE_URL=postgresql://postgres:<pw>@localhost:5432/atom_test npx jest integration --runInBand
```

## Migrations

- File name `NNN_short_name.sql` (e.g. `002_users.sql`), applied in order, each in one transaction.
- Idempotent (`IF NOT EXISTS`, enum recreate pattern). No `BEGIN`/`COMMIT` inside the file.
- Never edit an applied migration — add a new one.

## Deploy to IIS (summary)

1. Server prerequisites: iisnode x64, URL Rewrite, WebSocket Protocol feature.
2. Copy the repo to the IIS folder; `Atom` converted to **Application**, app pool `ATOM`.
3. `.env` at the project root (production values, `NODE_ENV=production`).
4. `cd server && npm ci --omit=dev`, `npm run migrate`; `cd client && npm ci && npm run build`.
5. `appcmd recycle apppool /apppool.name:"ATOM"`.
6. Open `/Atom/` — all three system checks OK; Real-time transport should read `websocket`
   (`polling` = WebSocket Protocol feature missing).

Full checklist: `ATOM_Project_Context.md` §6.

## Fonts

Self-hosted, not Google CDN. Drop the `.woff2` files into `client/public/fonts/`
(Amiri 400/700, Inter 300/400/500/700) — `@font-face` is added in the theme task.
Until then the stacks fall back to Georgia / Helvetica / Arial.

## Rules

- No secrets in code — `.env` only.
- Complete files per deliverable, one commit message each.
- Never log `req.body`, passwords or tokens.
- Soft delete only (`is_active = FALSE`).
