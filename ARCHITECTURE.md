# Architecture

ShowRoom is a small Node.js program with no dependencies. A scanner builds a catalog from your folders, a local server
serves it as a web page and runs the "open" actions, and a few JSON files in `~/.showroom/` hold everything you edit.

```
 Sources                                   Pipeline                                   Page
 ───────                                   ────────                                   ────
 project roots (folders)  ─┐
 ~/.claude/projects (sessions) ─┤→ scan() ─→ withLinks() ─→ applyCuration() ─→ withImages() ─→ index.html
 .showroom.json (per project) ─┘     ↑            ↑                ↑                  ↑            (cards)
                         ai-descriptions.json  links.json     curation.json     thumbs/ (sips, qlmanage)
```

## Modules (`src/`)

| File | Responsibility |
|---|---|
| `config.mjs` | Reads env vars → `~/.showroom/config.json` → defaults (and auto-detects common project folders). |
| `scan.mjs` | Walks each root's subfolders: kind detection, description from docs, last activity (files, git, sessions), Claude sessions (CLI transcripts merged with desktop-app sessions), actions. Also curation (`applyCuration`). |
| `images.mjs` | Picks a cover image per project and makes cached thumbnails with `sips` / `qlmanage`. |
| `links.mjs` | External links (claude.ai, Google Drive, Figma…): validation, type detection, cards and attached buttons. |
| `describe.mjs` | One-line descriptions written by the Claude Code CLI (`claude -p`, no tools, no saved session). Also a CLI. |
| `ai-cache.mjs` | Storage for AI descriptions. |
| `page.mjs` | Renders `web/index.html` with the catalog; strips server-only fields (`exec`). |
| `server.mjs` | Local HTTP server: page, thumbnails and the JSON API. |
| `build.mjs` | One-off scan that writes a static `index.html` (no server). |
| `agent.mjs` | Installs/removes the `launchd` LaunchAgent that keeps the server running. |

`web/index.html` is the whole front end: plain HTML, CSS and JavaScript, no build step.

## Data

Everything lives in `~/.showroom/` (or `$SHOWROOM_HOME`):

| File | Written by | Purpose |
|---|---|---|
| `config.json` | you | Roots, port, archive age, AI model/language. |
| `curation.json` | the page | Pinned, hidden, archived, tags, your descriptions, your images. Never overwritten by a scan. |
| `links.json` | the page | External links. |
| `ai-descriptions.json` | `describe` | Cached AI descriptions (generated once per project). |
| `images/` | the page | Images you pasted or uploaded. |
| `thumbs/` | scanner | Generated thumbnails (`index.json` caches them by source path, mtime and size). |
| `catalog.json`, `index.html` | `build` | Static output. |
| `server.log` | LaunchAgent | Server output. |

The catalog itself is never stored as the source of truth: it is recomputed from disk on every scan, and your choices are
applied on top. That is why a rescan never loses an edit.

## Precedence rules

- **Description**: your edit → `.showroom.json` → AI description you asked for explicitly → `CONTEXT.md` / `README.md` /
  `CLAUDE.md` (first paragraph, or the "Overview/About/Goal" section) → AI description from `npm run describe` → stack summary.
- **Image**: your image → `.showroom.json` `image` → app icon (`AppIcon.appiconset`, preferring `ios/` over the stock
  `macos/` icon Flutter generates) → screenshot/banner by file name → first local README image → Android launcher icon →
  logo/favicon → first page of the newest top-level document → initials.
- **Main action**: reopen the latest Claude Code session → Xcode / Android Studio → VS Code → Finder.

## Claude sessions

ShowRoom reads two sources and merges them by CLI session id:

- `~/.claude/projects/*/<uuid>.jsonl` — every Claude Code transcript (terminal or app), with its `cwd` and title.
- `~/Library/Application Support/Claude/claude-code-sessions/*/*/local_<id>.json` — sessions created in the Claude
  desktop app, each with its `cliSessionId`, folder, title and archived flag.

With `claude.open: "app"` the action is a `claude://` link opened with `open`:

| Latest session | Link |
|---|---|
| created in the app | `claude://code/continue?session=local_<id>` |
| started in a terminal | `claude://resume?session=<uuid>` (the app imports it) |
| none (secondary button) | `claude://code/new?folder=<absolute path>` |

With `"terminal"` it runs `claude --resume <uuid>` in the session's folder (see below). Archived app sessions are skipped.

## Server API

All `POST` endpoints require the `X-ShowRoom-Token` header (a random value embedded in the page at each start) and a
same-origin `Origin`. Every request must carry `Host: localhost:<port>` or `127.0.0.1:<port>`.

| Method | Path | Body | Does |
|---|---|---|---|
| GET | `/` | | The page. |
| GET | `/thumbs/<name>` | | A thumbnail. |
| GET | `/api/projects` | | The catalog (without executable commands). |
| POST | `/api/open` | `{ id, action }` | Runs action number `action` of project `id`. |
| POST | `/api/curate` | `{ id, patch }` | Edits `pinned`, `hidden`, `archived`, `description`, `tags`, or removes `imageFile`. |
| POST | `/api/image?id=` | image bytes | Sets a custom image (PNG/JPG/WebP/GIF, ≤ 8 MB, checked by signature). |
| POST | `/api/describe` | `{ id }` | Writes the description with Claude. |
| POST | `/api/links` | `{ id?, url, title, description?, attachTo? }` | Creates or updates a link. |
| POST | `/api/links/delete` | `{ id }` | Removes a link. |
| POST | `/api/rescan` | | Rescans now. |

Terminal actions write a self-deleting `.command` script to `~/.showroom/run/` and opens it with Terminal. Unlike
`osascript`, this doesn't require granting Automation permission.

## Design choices

- **Local server instead of a hosted app**: a web page alone can't open Xcode or a Terminal; a hosted service can't see your disk.
- **JSON files instead of a database**: a few hundred records fit in memory, and the files stay readable and easy to back up.
- **Automatic discovery plus curation**: registering projects by hand doesn't last; discovery without curation is noisy.
- **No automatic screenshots of web apps**: most modern `index.html` files are empty shells without their dev server, so
  headless captures come out blank. Pasting a screenshot is faster and more faithful.
- **AI descriptions are generated once**: regenerating on every file change would cost money for little benefit.
