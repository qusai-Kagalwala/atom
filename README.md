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
├─ sync/          Idarah sync (Windows Task Scheduler, not iisnode)
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
| client | `npm run dev` / `build` / `lint` | Vite dev / production build / ESLint |

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
