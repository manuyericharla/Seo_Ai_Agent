# AI SEO Agent Platform

Production-oriented MVP that crawls websites with **Playwright**, detects SEO issues, enriches findings with **OpenAI**, opens **GitHub Issues** for tracking, sends **email** reports via **Nodemailer**, persists data in **SQLite**, runs scheduled scans with **node-cron**, and exposes an **Angular** dashboard.

## Architecture

- **Backend:** Node.js, Express (`backend/src`)
- **Frontend:** Angular 18 (`frontend/angular-dashboard`)
- **AI:** OpenAI API (`gpt-4o-mini` in code)
- **Crawler:** Playwright (Chromium)
- **Scheduler:** Daily cron (default `0 9 * * *` UTC)
- **Email:** SMTP via Nodemailer
- **Database:** SQLite (`better-sqlite3`)

## Prerequisites

- Node.js 20+
- For local backend: Chromium installed via `npx playwright install chromium` (first run)

## Configuration

Copy `.env.example` to `.env` and set:

| Variable | Purpose |
|----------|---------|
| `OPENAI_API_KEY` | OpenAI API key |
| `GITHUB_TOKEN` | GitHub PAT with `repo` scope for target repo |
| `GITHUB_REPO` | `owner/repo` |
| `EMAIL_*` | SMTP settings |
| `EMAIL_FROM` | From header |
| `REPORT_EMAIL_TO` | Optional default recipient for scheduled reports |
| `CRON_SCHEDULE` | Cron expression (default `0 9 * * *`) |
| `MAX_PAGES_PER_SCAN` | Cap pages per crawl (default `25`). Set **`0`** to crawl all discoverable same-origin pages. |
| `CRAWL_WORKERS` | Concurrent crawler workers (default `12`, min `10`, max `20`). |
| `CRAWL_MAX_DEPTH` | Max internal-link depth from entry URLs (default `4`). |
| `CRAWL_TIMEOUT_MS` | Per-request timeout in milliseconds (default `12000`). |
| `BROKEN_LINK_CHECK_CAP` | Max internal links to validate with HEAD checks (default `200`). |
| `PORT` | API port (default `3000`) |

Secrets can also be stored from the **Settings** page in the UI (stored in SQLite on the server; masked in the API). Prefer environment variables in production.

## Local development

### Backend

```bash
cd backend
npm install
npx playwright install chromium
npm run dev
```

API base: `http://localhost:3000/api`  
Health: `GET http://localhost:3000/health`

### Frontend

```bash
cd frontend/angular-dashboard
npm install
npm start
```

`npm start` runs `ng serve` with `proxy.conf.json` so `/api` is forwarded to port 3000.

### Main API endpoints

- `POST /api/scan` — body: `{ "domain": "example.com", "emailTo?": "", "createGithubIssues?": false }` — response includes **`pageReports`** (per-URL JSON audit: score, issues, titles, meta, content & internal-link ideas). Uses local per-page checks + one OpenAI call for site-wide recommendations.
- `GET /api/reports/:scanId/json` — full page-level report JSON (same as saved file under `data/reports/{scanId}.json`, not in SQLite)
- `GET /api/reports` — scans + legacy `issues` rows (often empty for new audits)
- `GET /api/reports/:scanId/pdf` — professional PDF (per-page sections from `pageReports` when available)
- `POST /api/send-report` — body: `{ "scanId": 1, "emailTo": "you@x.com" }`
- `GET /api/domains` / `POST /api/domains`
- `GET /api/dashboard-stats`, `GET /api/activity`, `GET /api/seo-trend`
- `GET /api/settings` / `PUT /api/settings` (masked values)
- `POST /api/issues/:id/github` — create GitHub issue for one row

## Production build (single Node process)

```bash
cd frontend/angular-dashboard && npm install && npx ng build --configuration production
cd ../../backend && npm install && npm run build
node dist/server.js
```

Run from `backend/` so SQLite default path `data/seo-agent.db` is created under `backend/data`. The server serves the Angular build from `frontend/angular-dashboard/dist/.../browser` when present.

## Docker

```bash
cp .env.example .env
# edit .env
docker compose up --build
```

Application: `http://localhost:3000`  
SQLite file is persisted in the `seo-data` volume.

## Workflow

1. Add domains (Domains page) — included in the daily scheduler.
2. Manual **Scan domain** runs the pipeline immediately.
3. **SEO analyzer** flags missing titles/meta, multiple/missing H1, broken links, **non-functional links** (e.g. footer/social icons with `#`, empty `href`, or `javascript:`), images without ALT, slow pages.
4. **OpenAI** returns score, meta tags, and content improvements per page.
5. Optional **GitHub issues** and **email** on scan or from Issues / Scans screens.

### Crawl coverage

- Loads **`/sitemap.xml`** (and nested sitemaps when present) to seed URLs quickly.
- Crawls same-origin pages concurrently with a worker pool and depth limit.
- Extracts lightweight fields only (title, meta, H1/H2 counts, canonical, links, image alt coverage) for faster scans.

## Security notes

- API keys and tokens must not be committed; use `.env` or server-side Settings storage.
- The Angular app only talks to `/api`; it never embeds secrets.

## License

MIT (adjust as needed for your organization).
