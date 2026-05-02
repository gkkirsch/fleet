# fleet

Local web dashboard for orchestrating Claude Code agents. Sits on top of
[`roster`](https://github.com/gkkirsch/roster), [`camux`](https://github.com/gkkirsch/camux),
and [`amux`](https://github.com/gkkirsch/amux).

You talk to a dispatcher; it routes to an orchestrator; orchestrators
spawn workers. Each gets its own isolated `CLAUDE_CONFIG_DIR`, its own
dedicated headed Chrome profile, and a private workspace for live
artifacts you can watch render in an iframe as they're built.

## Install

```bash
curl -fsSL https://raw.githubusercontent.com/gkkirsch/director/main/install.sh | bash
```

macOS arm64 / amd64. Drops `amux`, `camux`, `roster`, and `fleetview`
into `~/.local/bin`, plus `agent-browser` via `npm i -g`.

Prereqs (the script will tell you what's missing): `tmux`, `node`,
[`claude`](https://docs.claude.com/en/docs/claude-code/cli-reference) (logged in).

Then:

```bash
fleetview &                   # dashboard at http://localhost:8080
roster spawn director --kind dispatcher --description "routes user requests"
```

Open the dashboard, message director — it'll spawn whatever orchestrator
the work needs.

## What you get

- **Sidebar tree** of every agent in the fleet (dispatcher → orchestrators
  → workers). Live status: ready / streaming / waiting on you / stopped.
  Collapse to a 56px rail when you want more chat width.
- **Chat panel** for every agent with markdown rendering, attachment chips
  (drag-and-drop, paperclip picker, paste image), 30-message pagination,
  Lucide-icon swap for ✓ ✗ ⚠ ✅ ❌, ArrowUp send button that flips to a
  filled stop square when the orch is mid-stream.
- **Settings sheet** — per-orch view of installed plugins, marketplaces,
  skills, sub-agents, custom commands, memory, and a credentials form for
  any plugin that ships a `credentials.json`.
- **Browser sheet** — launch the orch's dedicated Chrome on its
  deterministic CDP port (one per orch, derived from the id). Profile name
  + theme color match the orch so windows are recognizable at a glance.
- **Artifact sheet** — every orch can `roster artifact create <aid>`
  scaffold a Vite + React 19 + Tailwind v4 + lucide-react starter. fleet
  lazy-spawns Vite, points an iframe at it, and Vite's HMR pushes every
  save to the preview live. Edit Design mode adds a hover-highlight
  inspector inside the iframe — click any element to leave a comment;
  comments queue in a tray and send back to the orch as a structured
  notify with the source location (`src/App.tsx:42 · h1.text-4xl`).
  Fullscreen + open-in-new-tab buttons in the panel header.
- **Schedules sheet** — CRUD on the orch's `scheduled_tasks.json` (the
  file Claude Code reads natively for durable cron jobs). Frequency
  picker covers Once / Minutes / Hourly / Daily (multi-time) / Weekdays
  / Weekly. Click any row to edit; humanCron renders "Weekdays at 9 AM"
  inline.

## Run

```bash
make build              # builds Go binary + Vite UI

# dev — two processes
./fleetview             # backend on :8080
cd web && npm run dev   # Vite dev server on :5173 (proxies /api to :8080)

# then open http://localhost:5173
```

Requires `roster`, `camux`, and `amux` on `$PATH`. Polls `/api/fleet`
every couple seconds — no auth, no SSE, runs only on `127.0.0.1`.

## API surface

```
GET    /api/fleet                                list of agents (status + jsonl path)
GET    /api/agents/:id/messages                  parsed JSONL turns
POST   /api/agents/:id/notify                    paste a message into the recipient TUI
POST   /api/agents/:id/interrupt                 send Esc (stop button)
GET    /api/agents/:id/claude                    plugins / skills / commands / memory
POST   /api/agents/:id/plugins/install           shell out to `claude plugin install`
GET|POST|DELETE /api/agents/:id/credentials      macOS Keychain CRUD
GET|POST /api/agents/:id/browser                 status / launch headed Chrome
POST   /api/agents/:id/upload                    multipart file upload (drag-drop)

GET    /api/agents/:id/artifacts                 list of artifacts (with status)
POST   /api/agents/:id/artifacts/:aid/serve      lazy-spawn Vite
POST   /api/agents/:id/artifacts/:aid/stop       SIGTERM the dev server

GET    /api/agents/:id/schedules                 list (humanCron-enriched)
POST   /api/agents/:id/schedules                 create
PATCH  /api/agents/:id/schedules/:taskId         update
DELETE /api/agents/:id/schedules/:taskId         delete

GET    /__inspector.js                           served into artifact iframes
```
