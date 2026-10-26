# Agent Flow for zidane

A [zidane](https://github.com/Tahul/zidane) extension that shows how the agent works, live: every run becomes a tree of **turns → tool calls → subagents → their turns and tools**, drawn as an Airflow-style tree with a timeline, or as a graph, in a Linear-style UI.

- **Tree view**: indented tree with guides on the left, a Gantt timeline on the right. Running bars animate; a turn's bar shows model time (solid) and the time its tools took (tinted).
- **Graph view**: left-to-right DAG with curved edges. Click (or Tab + Enter) any step to see what happened; drag to pan, pinch or ⌘/ctrl+scroll to zoom, double-click to fold.
- **Written for non-technical readers**: steps read as "Thinking step 2", "Ran a command", "Read a file", "Handed off a task", "Helper 1". The detail panel explains each step in a sentence ("The assistant ran the command “bun test” on the computer. It finished in 2 seconds."), then shows what it said, what came back and what went wrong, with links to the steps it led to. Reasoning and technical details (model, tokens, cost, call id, raw input) sit in collapsed sections.
- **Live now**: the start page. One card per conversation working right now (what it is doing at this moment, actions taken, helpers working, elapsed time), then the recently finished ones. Cards keep their place as others start.
- **Many sessions at once**: the sidebar lists conversations that are working first (with a live dot), each showing its latest 3 requests. "Follow this conversation" jumps to that conversation's newest request and never to another conversation's. A per-conversation history (bar height = duration) sits in the header.
- **In zidane**: a **Flow** side-panel tab (latest run of the session as a native tree, plus a link to the full view), a `/flow` command, an "Open Agent Flow" palette entry, and settings in `Settings → Extensions & Plugins`.

- **Looks like your zidane**: in the desktop app, the view uses zidane's live theme: the same colors (light or dark, theme, accent override, contrast), fonts and interface size, and follows you when you change them (within ~2 s). The footer's Colors picker switches between `zidane`, `Light` and `Dark`; without the desktop app, `Auto` follows the system.
- **Zoom**: ⌘/Ctrl `+` / `−` / `0`, or the −/100%/+ control in the top bar, scales the whole page (40–200%). It starts at zidane's interface size; clicking the percentage (or ⌘0) goes back to matching it. The graph also zooms on its own, 8–300%.
- **See everything at once**: "Fit to screen" (or `0`) puts every step of the graph on screen. A request opens fitted whenever that stays legible. Zoomed out, graph nodes switch to one large word each ("Step 2", "Command", "Read", "Hand-off", "Helper 1") so the overview stays readable.
- **Small screens** (zidane's Browser tab): below ~980px the sidebar folds away (toggle with the top-left button or `S`; the "Live now" breadcrumb gets you back to the overview), the request header shrinks to one line when height is short (its arrow toggles it), below ~1100px the detail panel slides over the view instead of narrowing it, and the top bar drops button labels before it runs out of room. Your choices are remembered.

Keyboard: `o` Live now, `j`/`k` move, `←`/`→` fold, `Enter` toggle, `g` tree/graph, `f` follow, `[`/`]` previous/next run, `/` filter, `0` fit graph, `Esc` close inspector.

## Install

Needs zidane 8.2 or newer.

**From GitHub** (recommended): in zidane, `Settings → Extensions & Plugins`, install from source `tmickleydoyle/zidane-agent-flow` (TUI: `ctrl+g` in that tab), global scope.

**From a checkout** (to hack on it): zidane's discovery refuses symlinked extension folders, so copy it:

```sh
git clone https://github.com/tmickleydoyle/zidane-agent-flow.git
cd zidane-agent-flow
bun install
bun run install:local    # rsync to ~/.zidane/extensions/agent-flow/
```

Re-run `install:local` after edits. The extension has no runtime dependencies.

**Then load it.** The TUI picks up a new folder within seconds (or run `/reload`). The desktop app loads extensions at start: quit it fully (⌘Q) and reopen. If you use the zidane daemon (`Use daemon` on, where conversations run), the daemon also needs to load it: restart the daemon, or switch Agent Flow off and on once in `Settings → Extensions & Plugins` (the Settings list only appears with a folder open).

Open the view with `/flow`, the command palette ("Open Agent Flow"), the Flow panel, or http://127.0.0.1:7428/. Your next request shows up there; earlier ones were not recorded.

## Settings

| Key | Default | |
|---|---|---|
| `port` | `7428` | Local port (127.0.0.1 only). A taken port falls back to a free one. |
| `persist` | `true` | Keep the last 60 runs in `<zidane data dir>/extensions/agent-flow/runs.json` across restarts. |
| `open` | action | Opens the view; its status shows the URL. |

## How it works

```
index.ts         setup: shared store + server, panel, /flow, palette, config
src/hooks.ts     AgentHooks → store (session:start, turn:*, stream:*, tool:*, spawn:*, child:*)
src/store.ts     the run trees (pure, no zidane runtime imports)
src/server.ts    node:http: static UI, /api/runs, /api/runs/:id, /api/runs/:id/nodes/:node, SSE /api/events
src/panel.ts     PanelContent for the Flow tab
ui/              index.html, styles.css, app.js (vanilla, no build step)
```

Attribution notes (learned from zidane's hook payloads):

- Run ids are per-agent counters (`run_1`), so runs are keyed `<sessionId>/<runId>`.
- `session:start` stores the session id in the extension's session bag; every later hook, `child:*` included, runs in the run's async context and reads it back, so concurrent sessions stay apart.
- Child ids repeat (every agent's first child is `child-1`), so subagents are keyed by the `spawn` call id. Child tool events carry it as `parentCallId`; child text and turn events only have `{ childId, depth }` and are matched through the turn, then corrected when the turn's first tool call arrives.
- `turn:after` fires before the turn's tools run; a turn stays open until its tools finish.
- Codemode's inner tool calls nest under the codemode call through `parentToolCallId`.

With many sessions running at once: every event finds its own session through the run's async context; an event that cannot (a host without sessions) is only attributed when exactly one run is open, never guessed. Run summaries are cached per run version, so the list only re-walks runs that changed; the Flow panel refreshes at most once a second; history is saved within a second of a run ending and at most every 10 s while runs stream. A test runs 16 sessions with subagents concurrently and checks that no step lands in another session's tree.

Appearance: the desktop app keeps its theme in its window (CSS variables on `<html>`, preferences in the window's localStorage), not in shared settings, and extensions run in its main process. So the extension asks the app window directly with a read-only script that collects the computed `--zg-*` variables and the zoom factor (`src/appearance.ts`), sanitizes them, and serves them at `/api/appearance`, pushing changes to open viewers. The page maps its own colors onto zidane's token contract (`--zg-bg`, `--zg-tray`, `--zg-raised`, `--zg-text*`, `--zg-accent`, `--zg-warn`/`success`/`danger`, `--zg-font-ui`/`mono`…). In the terminal app and the daemon there is no app window to read, so the view uses its built-in light or dark palette.

No phantom "working" requests. A request is shown as working only from `session:start` until its end (`session:end` / `agent:done`). zidane does not send an end when a run's setup fails after `agent:start` (e.g. a sandbox that cannot start: no `session:end`, no `agent:done`), so two safeguards close such runs, marked "ended, zidane didn't say how": the next request in the same conversation (a conversation runs one request at a time), and, in the desktop app and daemon, the host's run-settled signal for that conversation. A run closed this way reopens if it reports anything again, so a live run is never hidden. When the page loses its connection it says so, stops every timer and animation, and words running requests in the past tense ("Was working"). Requests quiet for over a minute show "Quiet for N min" (waiting for you, or a long task). Demo data is labeled as such.

Several zidane processes. With "Use daemon" on, conversations run in the zidane daemon while the desktop app's main process paints panels and holds the theme; terminal sessions are processes of their own. Each process that loads the extension records its own agents and serves the page (the first on 7428, the others on free ports). They find each other through one small file per process in a per-user temp directory (`$TMPDIR/zidane-agent-flow-<uid>/peers/`, stale entries of dead processes removed on read), and every page and every Flow panel shows the union: run lists are merged, a request's details come from whichever process holds it, live changes are relayed (peers subscribe to each other's own changes only, so nothing loops), and a process without a theme (the daemon) borrows the desktop app's. Each kind of process keeps its own history file (`runs-desktop.json`, `runs-daemon.json`, `runs-terminal.json`).

The daemon loads extensions when its extension settings change. After installing, switch Agent Flow off and on once in `Settings → Extensions & Plugins` (or restart zidane fully, daemon included) so the daemon starts recording.

One store and server serve every registry in the process (the desktop app builds one per project); the server closes when the last registry is disposed. The server answers only requests addressed to `127.0.0.1`/`localhost` on its port (DNS-rebinding guard), since tool inputs and outputs are visible through it.

Panels in zidane are data-only (rows, key-values, markdown), which is why the full view is a local web page and the panel is a summary.

## Develop

```sh
bun install
bun test             # store unit tests + real zidane agents through the extension
bun run typecheck
bun run demo         # scripted agents (no LLM) streaming into http://127.0.0.1:7430/
DEMO_THEME=light DEMO_SCALE=1.15 bun run demo   # as if zidane's desktop app used that theme and size (needs ../zidane)
```
