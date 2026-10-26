// Agent Flow UI: vanilla JS, no build step. Data comes from the extension's
// local server: /api/runs (list), /api/runs/:id (tree without heavy text),
// /api/runs/:id/nodes/:nodeId (one node in full), /api/events (SSE).

const $ = sel => document.querySelector(sel)

const STATUS_LABEL = { queued: 'Waiting', running: 'Working…', success: 'Done', error: 'Didn’t work', cancelled: 'Stopped' }
const KIND_LABEL = { run: 'Your request', turn: 'Thinking step', tool: 'Action', agent: 'Helper' }
const GW = 236
const GH = 56
const GX = 72
const GY = 14

const params = new URLSearchParams(location.search)

const state = {
  skew: 0,
  runs: [],
  sessions: {},
  runId: null,
  run: null,
  index: new Map(),
  // Follow = stay on the open conversation and jump to its newest request.
  follow: true,
  pendingRun: params.get('run'),
  pendingSession: params.get('session'),
  expandedSessions: new Set(),
  view: localStorage.getItem('agent-flow.view') === 'graph' ? 'graph' : 'tree',
  collapsed: new Map(),
  selected: null,
  full: new Map(),
  filter: '',
  graph: { x: 40, y: 40, k: 1, fittedFor: null },
  /** null until the first connection attempt resolves. */
  online: null,
  /** When the connection to zidane dropped: time stops there, nothing is live. */
  offlineAt: null,
  label: '',
}

// ------------------------------------------------------------------ utils

const esc = value => String(value ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', '\'': '&#39;' })[c])
const now = () => Math.min(Date.now() + state.skew, state.offlineAt ?? Infinity)
const isOpen = s => s === 'running' || s === 'queued'

function fmtDur(ms) {
  if (!Number.isFinite(ms))
    return ''
  if (ms < 1000)
    return `${Math.max(0, Math.round(ms))}ms`
  const s = ms / 1000
  if (s < 60)
    return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`
  const m = Math.floor(s / 60)
  if (m < 60)
    return `${m}m ${Math.round(s % 60)}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

function fmtTick(ms) {
  if (ms === 0)
    return '0'
  if (ms < 1000)
    return `${ms}ms`
  if (ms < 60_000)
    return `${+(ms / 1000).toFixed(1)}s`
  const m = Math.floor(ms / 60_000)
  const s = Math.round((ms % 60_000) / 1000)
  return s ? `${m}m ${s}s` : `${m}m`
}

function fmtTok(n) {
  if (!n)
    return '0'
  if (n >= 1e6)
    return `${(n / 1e6).toFixed(1)}M`
  if (n >= 1e3)
    return `${(n / 1e3).toFixed(1)}k`
  return String(n)
}

function fmtBytes(n) {
  if (n < 1024)
    return `${n} B`
  if (n < 1024 * 1024)
    return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(1)} MB`
}

function relTime(t) {
  const s = (now() - t) / 1000
  if (s < 45)
    return 'now'
  if (s < 3600)
    return `${Math.round(s / 60)}m`
  if (s < 86400)
    return `${Math.round(s / 3600)}h`
  return `${Math.round(s / 86400)}d`
}

const clockTime = t => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', second: '2-digit' })
const durOf = n => (n.endedAt ?? now()) - n.startedAt

function throttle(fn, ms) {
  let timer = null
  let again = false
  let running = false
  const run = async () => {
    timer = null
    if (running) {
      again = true
      return
    }
    running = true
    try {
      await fn()
    }
    finally {
      running = false
      if (again) {
        again = false
        timer ??= setTimeout(run, ms)
      }
    }
  }
  return () => {
    timer ??= setTimeout(run, ms)
  }
}

async function getJson(url) {
  const res = await fetch(url, { cache: 'no-store' })
  if (!res.ok)
    throw new Error(`${res.status} ${res.statusText}`)
  const data = await res.json()
  if (typeof data.now === 'number')
    state.skew = data.now - Date.now()
  return data
}

// ------------------------------------------------------------------ icons

function statusIcon(status) {
  switch (status) {
    case 'queued':
      return `<svg class="st c-queued" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.5" fill="none" stroke="currentColor" stroke-width="1.5" stroke-dasharray="2.4 2.2"/></svg>`
    case 'running':
      return `<svg class="st c-running spin" viewBox="0 0 14 14"><circle cx="7" cy="7" r="5.6" fill="none" stroke="currentColor" stroke-width="1.5"/><path class="pie" d="M7 3.4A3.6 3.6 0 0 1 7 10.6Z" fill="currentColor"/></svg>`
    case 'success':
      return `<svg class="st c-success" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6.2" fill="currentColor"/><path class="ink-s" d="m4.4 7.2 1.8 1.8 3.5-3.7" fill="none" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round"/></svg>`
    case 'error':
      return `<svg class="st c-error" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6.2" fill="currentColor"/><path class="ink-s" d="M7 4v3.6" stroke-width="1.6" stroke-linecap="round"/><circle class="ink-f" cx="7" cy="9.9" r="0.95"/></svg>`
    default:
      return `<svg class="st c-cancelled" viewBox="0 0 14 14"><circle cx="7" cy="7" r="6.2" fill="currentColor"/><path class="ink-s" d="m5 5 4 4m0-4-4 4" stroke-width="1.5" stroke-linecap="round"/></svg>`
  }
}

const svg = (d, extra = '') => `<svg width="14" height="14" viewBox="0 0 16 16" fill="none" stroke="currentColor" stroke-width="1.4" stroke-linecap="round" stroke-linejoin="round"${extra}>${d}</svg>`
const ICON = {
  run: svg('<path d="M5 3.2v9.6L12.5 8z"/>'),
  turn: svg('<path d="M8 2v2.5M8 11.5V14M2 8h2.5M11.5 8H14M8 5.5 9 7l1.5 1L9 9l-1 1.5L7 9 5.5 8 7 7z"/>'),
  agent: svg('<rect x="3" y="5" width="10" height="8" rx="2"/><path d="M8 2.5V5M6 9h.01M10 9h.01"/>'),
  terminal: svg('<rect x="2" y="3" width="12" height="10" rx="2"/><path d="m5 6.5 2 1.5-2 1.5M8.5 10h2.5"/>'),
  file: svg('<path d="M4 2.5h5l3 3v8H4z"/><path d="M9 2.5v3h3"/>'),
  search: svg('<circle cx="7" cy="7" r="4"/><path d="m10 10 3.5 3.5"/>'),
  globe: svg('<circle cx="8" cy="8" r="5.5"/><path d="M2.5 8h11M8 2.5c1.6 1.6 2.3 3.4 2.3 5.5S9.6 11.9 8 13.5C6.4 11.9 5.7 10.1 5.7 8S6.4 4.1 8 2.5z"/>'),
  code: svg('<path d="m5.5 5-3 3 3 3M10.5 5l3 3-3 3M9 3.5l-2 9"/>'),
  branch: svg('<circle cx="4.5" cy="3.5" r="1.5"/><circle cx="4.5" cy="12.5" r="1.5"/><circle cx="11.5" cy="5.5" r="1.5"/><path d="M4.5 5v6M11.5 7c0 2.5-3 2.5-7 4"/>'),
  todo: svg('<path d="m3 4.5 1 1 2-2M3 10.5l1 1 2-2M8.5 4.5h4.5M8.5 10.5h4.5"/>'),
  ask: svg('<path d="M2.5 4a1.5 1.5 0 0 1 1.5-1.5h8A1.5 1.5 0 0 1 13.5 4v6a1.5 1.5 0 0 1-1.5 1.5H7l-3 2.5v-2.5a1.5 1.5 0 0 1-1.5-1.5z"/>'),
  plug: svg('<path d="M6 2.5v3M10 2.5v3M4.5 5.5h7v2.5a3.5 3.5 0 0 1-7 0zM8 11.5V14"/>'),
  tool: svg('<path d="M10 2.8a3 3 0 0 0-3.6 3.8L2.8 10.2a1.4 1.4 0 0 0 2 2l3.6-3.6A3 3 0 0 0 12.2 5l-1.8 1.8-1.6-.4-.4-1.6z"/>'),
  chev: svg('<path d="m6 4 4 4-4 4"/>', ' stroke-width="1.6"'),
  close: svg('<path d="m4 4 8 8m0-8-8 8"/>'),
}

function toolIcon(name = '') {
  const n = name.toLowerCase()
  if (/spawn|subagent/.test(n))
    return ICON.branch
  if (/codemode|eval|repl/.test(n))
    return ICON.code
  if (/^mcp_/.test(n))
    return ICON.plug
  if (/web|fetch|url|browser|http/.test(n))
    return ICON.globe
  if (/shell|bash|exec|terminal|command|wait_task/.test(n))
    return ICON.terminal
  if (/grep|glob|search|find|list/.test(n))
    return ICON.search
  if (/read|write|edit|file|patch/.test(n))
    return ICON.file
  if (/todo/.test(n))
    return ICON.todo
  if (/ask|plan|question/.test(n))
    return ICON.ask
  return ICON.tool
}

const kindIcon = n => n.kind === 'tool' ? toolIcon(n.data?.tool || n.label) : ICON[n.kind] || ICON.tool

// ------------------------------------------------------- plain language

const quote = s => `“${s}”`
const capital = s => s.charAt(0).toUpperCase() + s.slice(1)
const humanize = name => capital(name.replace(/^mcp_[^_]+_/, '').replace(/[_-]+/g, ' ').trim())

/** [pattern on the tool name, title, sentence from the call's one-line summary] */
const ACTIONS = [
  [/^mcp_/, name => `Used ${capital(/^mcp_([^_]+)_/.exec(name)?.[1] ?? 'a connected app')}`, (d, name) => `The assistant used a connected app (${capital(/^mcp_([^_]+)_/.exec(name)?.[1] ?? 'app')}) to ${humanize(name).toLowerCase()}${d ? `: ${quote(d)}` : ''}.`],
  [/^spawn$|subagent/, 'Handed off a task', d => d ? `The assistant asked a helper to take care of this: ${quote(d)}` : 'The assistant handed part of the work to a helper.'],
  [/codemode/, 'Did several things at once', () => 'The assistant ran a small script that performs several actions in one go. Each one is listed below.'],
  [/web_search/, 'Searched the web', d => `The assistant searched the web for ${quote(d)}.`],
  [/^browser/, 'Used the browser', d => `The assistant used a web browser${d ? ` (${d})` : ''}.`],
  [/web|fetch|url|http/, 'Opened a web page', d => `The assistant opened the web page ${d}.`],
  [/wait_task/, 'Waited for a task', () => 'The assistant waited for a task running in the background to finish.'],
  [/shell|bash|exec|terminal|command/, 'Ran a command', d => `The assistant ran the command ${quote(d)} on the computer.`],
  [/grep|search/, 'Searched the project', d => `The assistant searched the project’s files for ${quote(d)}.`],
  [/glob|list|find/, 'Looked for files', d => `The assistant looked for files matching ${quote(d)}.`],
  [/read/, 'Read a file', d => `The assistant opened and read ${d}.`],
  [/write/, 'Wrote a file', d => `The assistant wrote the file ${d}.`],
  [/edit|patch/, 'Changed a file', d => `The assistant made changes to ${d}.`],
  [/todo/, 'Updated its to-do list', () => 'The assistant updated its own to-do list to keep track of the work.'],
  [/ask_user|question/, 'Asked you a question', d => `The assistant stopped to ask you something${d ? `: ${quote(d)}` : '.'}`],
  [/plan/, 'Proposed a plan', () => 'The assistant proposed a plan and waited for your go-ahead.'],
  [/artifact/, 'Saved a result', d => `The assistant saved a result for you${d ? `: ${d}` : ''}.`],
]

/** One or two words per step, for the zoomed-out graph. Same order as ACTIONS. */
const SHORT = [
  [/^mcp_/, name => capital(/^mcp_([^_]+)_/.exec(name)?.[1] ?? 'App')],
  [/^spawn$|subagent/, 'Hand-off'],
  [/codemode/, 'Script'],
  [/web_search/, 'Web search'],
  [/^browser/, 'Browser'],
  [/web|fetch|url|http/, 'Web page'],
  [/wait_task/, 'Wait'],
  [/shell|bash|exec|terminal|command/, 'Command'],
  [/grep|search/, 'Search'],
  [/glob|list|find/, 'Find files'],
  [/read/, 'Read'],
  [/write/, 'Write'],
  [/edit|patch/, 'Edit'],
  [/todo/, 'To-do'],
  [/ask_user|question/, 'Question'],
  [/plan/, 'Plan'],
  [/artifact/, 'Saved'],
]

function shortLabel(n) {
  if (n.kind === 'run')
    return 'Request'
  if (n.kind === 'turn')
    return `Step ${(n.data?.turn ?? 0) + 1}`
  if (n.kind === 'agent')
    return describe(n).title
  const name = (n.data?.tool || n.label).toLowerCase()
  for (const [re, word] of SHORT) {
    if (re.test(name))
      return typeof word === 'function' ? word(name) : word
  }
  return humanize(n.data?.tool || n.label)
}

/** How a step reads to someone who does not code: a title, a short subtitle, a sentence. */
function describe(n) {
  const d = n.detail || ''
  if (n.kind === 'run')
    return { title: n.label, sub: 'Your request', sentence: 'This is everything the assistant did to handle your request, step by step.' }
  if (n.kind === 'turn') {
    const step = (n.data?.turn ?? 0) + 1
    const acts = n.children?.filter(c => c.kind === 'tool').length ?? 0
    const said = n.has?.includes('text') || n.data?.text
    const sub = d.startsWith('→') ? `Decided to take ${acts} action${acts === 1 ? '' : 's'}` : d
    return {
      title: `Thinking step ${step}`,
      sub: sub || 'Thinking…',
      sentence: `The assistant looked at everything so far and decided what to do next.${acts ? ` It then took ${acts} action${acts === 1 ? '' : 's'}, listed below.` : said ? ' It wrote the reply below.' : ''}`,
    }
  }
  if (n.kind === 'agent') {
    const num = /(\d+)$/.exec(n.data?.childId || n.label)?.[1]
    return {
      title: `Helper${num ? ` ${num}` : ''}`,
      sub: d || 'Working on a handed-off task',
      sentence: 'A helper is a second assistant the main one called in. It works on its own part of the job and reports back when done.',
    }
  }
  const name = n.data?.tool || n.label
  for (const [re, title, sentence] of ACTIONS) {
    if (re.test(name.toLowerCase()))
      return { title: typeof title === 'function' ? title(name) : title, sub: d, sentence: sentence(d, name) }
  }
  return { title: humanize(name), sub: d, sentence: `The assistant used the “${humanize(name)}” tool${d ? ` with ${quote(d)}` : ''}.` }
}

function humanDur(ms) {
  if (ms < 1000)
    return 'less than a second'
  const s = Math.round(ms / 1000)
  if (s < 60)
    return `${s} second${s === 1 ? '' : 's'}`
  const m = Math.floor(s / 60)
  const r = s % 60
  return `${m} minute${m === 1 ? '' : 's'}${r ? ` ${r} second${r === 1 ? '' : 's'}` : ''}`
}

const PRESENT = [
  [/^Ran\b/, 'Running'], [/^Read\b/, 'Reading'], [/^Searched\b/, 'Searching'], [/^Opened\b/, 'Opening'],
  [/^Changed\b/, 'Changing'], [/^Wrote\b/, 'Writing'], [/^Handed off\b/, 'Handing off'], [/^Did\b/, 'Doing'],
  [/^Looked\b/, 'Looking'], [/^Updated\b/, 'Updating'], [/^Asked\b/, 'Asking'], [/^Proposed\b/, 'Proposing'],
  [/^Saved\b/, 'Saving'], [/^Used\b/, 'Using'], [/^Waited\b/, 'Waiting'],
  [/^Thinking step.*$/, 'Thinking'], [/^(Helper.*)$/, '$1 is working'],
]
const presentTense = title => PRESENT.reduce((t, [re, to]) => re.test(t) ? t.replace(re, to) : t, title)

function outcomeSentence(n) {
  const took = humanDur(durOf(n))
  switch (n.status) {
    case 'running': return `This is still going (${took} so far).`
    case 'queued': return 'This is waiting to start.'
    case 'error': return `This didn’t work. It stopped after ${took}; what went wrong is shown below.`
    case 'cancelled': return 'This was stopped before it finished.'
    default: return `It finished in ${took}.`
  }
}

// ------------------------------------------------- appearance and zoom

/**
 * Theme: 'zidane' (the desktop app's live theme, when the extension can read
 * it), 'light' or 'dark'. 'auto' = zidane's when available, else the OS's.
 * Zoom: the user's own pick, else zidane's interface scale, else 100%.
 */
const appearance = {
  pref: localStorage.getItem('agent-flow.theme') || 'auto',
  zidane: null,
  zoom: Number(localStorage.getItem('agent-flow.zoom')) || null,
}
const ZOOM = { min: 0.4, max: 2, step: 0.1 }

/**
 * Room on small screens (zidane's Browser tab is often ~800×600): the
 * sidebar folds away and the request header shrinks to one line when space
 * is short, unless the user chose otherwise.
 */
const ui = {
  sidebar: localStorage.getItem('agent-flow.sidebar') || 'auto',
  header: localStorage.getItem('agent-flow.header') || 'auto',
  sidebarOpen: true,
  compactHeader: false,
}

function applyLayout() {
  const z = effectiveZoom()
  const w = window.innerWidth / z
  const h = window.innerHeight / z
  ui.sidebarOpen = ui.sidebar === 'open' || (ui.sidebar === 'auto' && w >= 980)
  ui.compactHeader = ui.header === 'compact' || (ui.header === 'auto' && h < 720)
  $('#app').classList.toggle('no-sidebar', !ui.sidebarOpen)
  // Narrow windows: the detail panel slides over the view instead of taking a column.
  $('#app').classList.toggle('narrow', w < 1100)
  $('#runbar').classList.toggle('compact', ui.compactHeader)
  $('#toggle-sidebar').title = ui.sidebarOpen ? 'Hide the sidebar (S)' : 'Show the sidebar (S)'
  $('#toggle-sidebar').classList.toggle('on', ui.sidebarOpen)
}

function toggleSidebar() {
  ui.sidebar = ui.sidebarOpen ? 'closed' : 'open'
  localStorage.setItem('agent-flow.sidebar', ui.sidebar)
  applyLayout()
  afterResize()
}

function toggleHeader() {
  ui.header = ui.compactHeader ? 'full' : 'compact'
  localStorage.setItem('agent-flow.header', ui.header)
  applyLayout()
  renderHeader()
  afterResize()
}

/** Keep the graph showing everything when its box changes size, if it was fitted. */
function afterResize() {
  if (state.view === 'graph' && state.runId && state.graph.fitted)
    requestAnimationFrame(() => fitGraph())
}
const osDark = window.matchMedia('(prefers-color-scheme: dark)')

function effectiveZoom() {
  return appearance.zoom ?? appearance.zidane?.scale ?? 1
}

function applyAppearance() {
  const root = document.documentElement
  const z = appearance.zidane
  const useZidane = z && (appearance.pref === 'auto' || appearance.pref === 'zidane')
  // Clear the previous zidane tokens, then set the current ones.
  for (const name of [...root.style].filter(n => n.startsWith('--zg-')))
    root.style.removeProperty(name)
  if (useZidane) {
    for (const [name, value] of Object.entries(z.vars))
      root.style.setProperty(name, value)
  }
  root.classList.toggle('zg', !!useZidane)
  const light = useZidane ? z.appearance === 'light' : appearance.pref === 'light' || (appearance.pref !== 'dark' && !osDark.matches)
  root.dataset.theme = light ? 'light' : 'dark'
  root.style.colorScheme = light ? 'light' : 'dark'
  root.style.zoom = String(effectiveZoom())
  root.style.setProperty('--page-zoom', String(effectiveZoom()))
  renderAppearanceControls()
  applyLayout()
}

function renderAppearanceControls() {
  const pct = Math.round(effectiveZoom() * 100)
  $('#zoom-pct').textContent = `${pct}%`
  $('#zoom-pct').title = appearance.zoom == null
    ? (appearance.zidane ? 'Matching zidane’s interface size' : 'Default size')
    : 'Click to match zidane’s size (⌘0)'
  const options = [
    ...(appearance.zidane ? [['auto', 'zidane']] : [['auto', 'Auto']]),
    ['light', 'Light'],
    ['dark', 'Dark'],
  ]
  const current = appearance.pref === 'zidane' ? 'auto' : appearance.pref
  $('#appearance').innerHTML = options.map(([id, label]) =>
    `<button data-theme-pick="${id}" class="${current === id ? 'on' : ''}" title="${id === 'auto' ? (appearance.zidane ? 'Same colors, fonts and size as zidane' : 'Follow the system') : `Always ${label.toLowerCase()}`}">${label}</button>`).join('')
}

function setZoom(next) {
  appearance.zoom = next == null ? null : Math.min(ZOOM.max, Math.max(ZOOM.min, Math.round(next * 100) / 100))
  if (appearance.zoom == null)
    localStorage.removeItem('agent-flow.zoom')
  else
    localStorage.setItem('agent-flow.zoom', String(appearance.zoom))
  applyAppearance()
  afterResize()
}

const zoomBy = dir => setZoom(effectiveZoom() + dir * ZOOM.step)

async function loadAppearance() {
  try {
    const data = await getJson('/api/appearance')
    appearance.zidane = data.appearance ?? null
  }
  catch {
    appearance.zidane = null
  }
  applyAppearance()
}

/** CSS px per screen px inside the zoomed page (pointer math in the graph). */
function pageZoom() {
  const el = $('#graph')
  const rect = el.getBoundingClientRect()
  return el.offsetWidth ? rect.width / el.offsetWidth : 1
}

// ------------------------------------------------------------- tree model

function collapsedSet() {
  if (!state.collapsed.has(state.runId))
    state.collapsed.set(state.runId, new Set())
  return state.collapsed.get(state.runId)
}

function indexRun(run) {
  const index = new Map()
  const walk = (node, parent) => {
    index.set(node.id, { node, parent })
    for (const child of node.children || [])
      walk(child, node)
  }
  walk(run.root, null)
  state.index = index
}

function visibleRows() {
  if (!state.run)
    return []
  const out = []
  const collapsed = collapsedSet()
  const walk = (node, guides) => {
    out.push({ node, guides })
    const kids = node.children || []
    if (!kids.length || collapsed.has(node.id))
      return
    const inherited = guides.map(g => (g === 'tee' || g === 'pipe') ? 'pipe' : 'blank')
    kids.forEach((child, i) => walk(child, [...inherited, i === kids.length - 1 ? 'elbow' : 'tee']))
  }
  walk(state.run.root, [])
  return out
}

function timeScale() {
  const run = state.run
  const t0 = run.startedAt
  const t1 = run.endedAt ?? now()
  const span = Math.max(t1 - t0, 1)
  // One label per ~80px of timeline.
  const maxTicks = Math.max(2, Math.floor(($('#ticks').clientWidth || 480) / 80))
  const steps = [100, 200, 500, 1e3, 2e3, 5e3, 1e4, 15e3, 3e4, 6e4, 12e4, 3e5, 6e5, 9e5, 18e5, 36e5, 72e5]
  const step = steps.find(s => s >= span / maxTicks) ?? steps.at(-1)
  const ticks = []
  for (let t = 0; t <= span; t += step)
    ticks.push(t)
  return { t0, span, ticks, pct: t => ((t - t0) / span) * 100 }
}

// ----------------------------------------------------------------- render

function render() {
  renderSidebar()
  renderHeader()
  renderMain()
  renderInspector()
}

function sessionTitle(sid) {
  if (state.sessions[sid])
    return state.sessions[sid]
  return sid === 'local' ? 'This computer' : `Conversation ${sid.slice(-4)}`
}

const newestOf = sid => state.runs.find(r => r.sessionId === sid)
const SIDEBAR_RUNS = 3

/** Demo data, or a lost connection: said plainly above everything. */
function renderGlobalBanner() {
  const parts = []
  if (state.label)
    parts.push(`<div class="gbanner demo">${esc(state.label)}</div>`)
  if (!state.online && state.offlineAt)
    parts.push('<div class="gbanner offline">Not connected to zidane. This is the last thing it reported, so anything shown as working may already have stopped. Reconnecting…</div>')
  $('#global-banner').innerHTML = parts.join('')
}

/** "Quiet for 4 min" when a working request has not reported anything for a while. */
function quietNote(r) {
  if (!isOpen(r.status) || !r.lastEventAt)
    return ''
  const quiet = now() - r.lastEventAt
  if (quiet < 60_000)
    return ''
  const min = Math.round(quiet / 60_000)
  return `Quiet for ${min} min`
}

function renderSidebar() {
  const running = state.runs.filter(r => isOpen(r.status)).length
  $('#live-now').classList.toggle('on', !state.runId)
  $('#live-count').textContent = running && !state.offlineAt ? `${running} working` : ''
  $('#follow').classList.toggle('hidden', !state.runId)
  $('#follow').classList.toggle('on', state.follow)
  const q = state.filter.trim().toLowerCase()
  const groups = new Map()
  for (const run of state.runs) {
    if (q && !`${run.prompt} ${sessionTitle(run.sessionId)}`.toLowerCase().includes(q))
      continue
    if (!groups.has(run.sessionId))
      groups.set(run.sessionId, [])
    groups.get(run.sessionId).push(run)
  }
  if (groups.size === 0) {
    $('#runs').innerHTML = `<div class="group-head"><span>${q ? 'Nothing matches' : 'No conversations yet'}</span></div>`
    return
  }
  // Conversations that are working come first, then the most recently active.
  const ordered = [...groups.entries()].sort(([, x], [, y]) =>
    (Number(y.some(r => isOpen(r.status))) - Number(x.some(r => isOpen(r.status)))) || (y[0].startedAt - x[0].startedAt))
  let html = ''
  for (const [sid, runs] of ordered) {
    const live = runs.some(r => isOpen(r.status))
    const all = q || state.expandedSessions.has(sid)
    const shown = all ? runs : runs.filter((r, i) => i < SIDEBAR_RUNS || r.id === state.runId)
    html += `<div class="group-head">${live ? '<i class="live-dot"></i>' : ''}<span>${esc(sessionTitle(sid))}</span><span class="count">${runs.length}</span></div>`
    for (const run of shown) {
      const dur = (run.endedAt ?? now()) - run.startedAt
      html += `<button class="run-item${run.id === state.runId ? ' on' : ''}" data-run="${esc(run.id)}" title="${esc(run.prompt)}">
        ${statusIcon(run.status)}
        <span class="title">${esc(run.prompt || 'Request')}</span>
        <span class="when">${relTime(run.startedAt)}</span>
        <span class="sub"><span>${run.stats.tools} action${run.stats.tools === 1 ? '' : 's'}${run.stats.agents ? ` · ${run.stats.agents} helper${run.stats.agents === 1 ? '' : 's'}` : ''}</span><span>${fmtDur(dur)}</span></span>
      </button>`
    }
    if (runs.length > shown.length)
      html += `<button class="show-more" data-expand-session="${esc(sid)}">Show ${runs.length - shown.length} earlier</button>`
    else if (!q && state.expandedSessions.has(sid) && runs.length > SIDEBAR_RUNS)
      html += `<button class="show-more" data-expand-session="${esc(sid)}">Show fewer</button>`
  }
  $('#runs').innerHTML = html
}

function renderHeader() {
  const run = state.run
  const runbar = $('#runbar')
  if (!run) {
    runbar.classList.add('hidden')
    $('#crumbs').innerHTML = `<span class="cur">${state.runId ? 'Loading…' : 'Live now'}</span>`
    $('#banner').innerHTML = ''
    return
  }
  const summary = state.runs.find(r => r.id === run.id)
  const stats = summary?.stats ?? { turns: 0, tools: 0, agents: 0, errors: 0, tokensIn: 0, tokensOut: 0, cost: 0 }
  const siblings = state.runs.filter(r => r.sessionId === run.sessionId).sort((a, b) => a.startedAt - b.startedAt)
  const ordinal = siblings.findIndex(r => r.id === run.id) + 1
  const sel = state.selected && state.selected !== run.root.id ? state.index.get(state.selected)?.node : null
  $('#crumbs').innerHTML = `<button class="crumb-link" data-overview>Live now</button><span class="sep">›</span><span>${esc(sessionTitle(run.sessionId))}</span><span class="sep">›</span><span class="${sel ? '' : 'cur'}">Request ${ordinal || ''}</span>${sel ? `<span class="sep">›</span><span class="cur">${esc(describe(sel).title)}</span>` : ''}`

  const recent = siblings.slice(-24)
  const maxDur = Math.max(...recent.map(r => (r.endedAt ?? now()) - r.startedAt), 1)
  runbar.classList.remove('hidden')
  runbar.innerHTML = `
    <div class="runbar-main">
      <button class="header-toggle" data-toggle-header title="${ui.compactHeader ? 'Show more about this request' : 'Make this header smaller'}">${ICON.chev}</button>
      <h1 class="run-title" title="${esc(run.prompt)}">${esc(run.prompt || 'Run')}</h1>
      <div class="chips">
        <span class="chip status">${statusIcon(run.status)}${isOpen(run.status) && state.offlineAt ? 'Was working' : STATUS_LABEL[run.status]}</span>
        <span class="chip optional">Started <b>${clockTime(run.startedAt)}</b></span>
        <span class="chip">Duration <b class="${run.status === 'running' ? 's-running-text' : ''}">${fmtDur(durOf(run))}</b></span>
        ${summary && quietNote(summary) ? `<span class="chip quiet" title="Nothing reported for a while: it may be waiting for you, or on a long task.">${quietNote(summary)}</span>` : ''}
        <span class="chip optional"><b>${stats.turns}</b> thinking step${stats.turns === 1 ? '' : 's'}</span>
        <span class="chip"><b>${stats.tools}</b> action${stats.tools === 1 ? '' : 's'}</span>
        ${stats.agents ? `<span class="chip"><b>${stats.agents}</b> helper${stats.agents === 1 ? '' : 's'}</span>` : ''}
        ${stats.cost > 0 ? `<span class="chip optional">Cost <b>$${stats.cost.toFixed(2)}</b></span>` : ''}
        ${stats.errors ? `<span class="chip c-error">${statusIcon('error')}<b>${stats.errors}</b> didn’t work</span>` : ''}
      </div>
    </div>
    ${recent.length > 1
      ? `<div class="history"><div class="history-label">Earlier requests</div><div class="history-bars">${recent.map((r) => {
        const d = (r.endedAt ?? now()) - r.startedAt
        return `<button class="hbar c-${r.status}${r.id === run.id ? ' on' : ''}" data-run="${esc(r.id)}" style="height:${Math.round(4 + 30 * (d / maxDur))}px;background:var(--c)" title="${esc(r.prompt)} · ${fmtDur(d)}"></button>`
      }).join('')}</div></div>`
      : ''}`
  $('#banner').innerHTML = run.truncated ? '<div class="banner">This run hit the node limit; later events were not recorded.</div>' : ''
}

function renderMain() {
  const empty = $('#empty')
  const overview = !state.runId
  $('#views').querySelectorAll('button').forEach(b => b.classList.toggle('on', b.dataset.view === state.view))
  for (const id of ['#views', '#expand-all', '#collapse-all'])
    $(id).classList.toggle('hidden', overview)
  $('#fit-screen').classList.toggle('hidden', overview || state.view !== 'graph')
  $('#overview').classList.toggle('hidden', !overview)
  if (overview) {
    $('#tree').classList.add('hidden')
    $('#graph').classList.add('hidden')
    empty.classList.add('hidden')
    renderOverview()
    return
  }
  if (!state.run) {
    $('#tree').classList.add('hidden')
    $('#graph').classList.add('hidden')
    empty.classList.remove('hidden')
    empty.innerHTML = '<div><h3>Loading…</h3><p>If this stays, the request may have been cleared from history.</p></div>'
    return
  }
  empty.classList.add('hidden')
  $('#tree').classList.toggle('hidden', state.view !== 'tree')
  $('#graph').classList.toggle('hidden', state.view !== 'graph')
  if (state.view === 'tree')
    renderTree()
  else
    renderGraph()
}

function overviewCard(r) {
  const open = isOpen(r.status)
  const dur = (r.endedAt ?? now()) - r.startedAt
  let doing
  if (r.activity) {
    const desc = describe(r.activity)
    doing = `<span class="kind">${kindIcon(r.activity)}</span><span class="now-title">${esc(presentTense(desc.title))}</span>${desc.sub ? `<span class="detail">${esc(desc.sub)}</span>` : ''}`
  }
  else {
    doing = `<span class="detail">${open ? 'Getting started…' : r.endedBy === 'inferred' ? 'Ended (zidane didn’t say how)' : r.status === 'error' ? 'Something didn’t work' : r.status === 'cancelled' ? 'Stopped before finishing' : `Finished in ${humanDur(dur)}`}</span>`
  }
  return `<button class="card c-${r.status}${open ? ' live' : ''}" data-run="${esc(r.id)}">
    <div class="card-top"><span class="card-session">${esc(sessionTitle(r.sessionId))}</span><span class="pill small c-${r.status}">${statusIcon(r.status)}${open && state.offlineAt ? 'Was working' : STATUS_LABEL[r.status]}</span></div>
    <div class="card-title">${esc(r.prompt || 'Request')}</div>
    <div class="card-now">${doing}</div>
    <div class="card-foot"><span>${r.stats.tools} action${r.stats.tools === 1 ? '' : 's'}</span>${r.helpersRunning ? `<span>${r.helpersRunning} helper${r.helpersRunning === 1 ? '' : 's'} working</span>` : r.stats.agents ? `<span>${r.stats.agents} helper${r.stats.agents === 1 ? '' : 's'}</span>` : ''}${r.stats.errors ? `<span class="c-error">${r.stats.errors} didn’t work</span>` : ''}${quietNote(r) ? `<span class="quiet" title="Nothing reported for a while: it may be waiting for you, or on a long task.">${quietNote(r)}</span>` : ''}<span class="spacer"></span><span class="${open ? 's-running-text' : ''}">${fmtDur(dur)}</span></div>
    ${open ? '<div class="card-bar"><i></i></div>' : ''}
  </button>`
}

/** Every conversation at a glance: what is working now, and what just finished. */
function renderOverview() {
  const el = $('#overview')
  const q = state.filter.trim().toLowerCase()
  const match = r => !q || `${r.prompt} ${sessionTitle(r.sessionId)}`.toLowerCase().includes(q)
  // Oldest first, so cards keep their place as new requests start.
  const running = state.runs.filter(r => isOpen(r.status) && match(r)).sort((x, y) => x.startedAt - y.startedAt)
  const recent = state.runs.filter(r => !isOpen(r.status) && match(r)).slice(0, 12)
  const scroll = el.scrollTop
  if (!state.runs.length) {
    el.innerHTML = `<div class="empty-inline"><div class="pulse">${ICON.branch}</div><h3>Waiting for the assistant</h3><p>Ask the assistant something in zidane. Every conversation shows up here as it works. Click one to see each step.</p></div>`
    return
  }
  el.innerHTML = `<div class="ov">
    <div class="ov-head">
      <h1>What’s happening now</h1>
      <p>${state.offlineAt
        ? (running.length ? `When the connection dropped, ${running.length} conversation${running.length === 1 ? ' was' : 's were'} working. They may have finished since.` : 'Nothing was running when the connection dropped.')
        : (running.length ? `${running.length} conversation${running.length === 1 ? ' is' : 's are'} working right now.` : 'Nothing is running right now.')} Click one to see every step it takes.</p>
    </div>
    ${running.length ? `<div class="cards">${running.map(overviewCard).join('')}</div>` : ''}
    ${recent.length ? `<h2 class="ov-sub">Recently finished</h2><div class="cards">${recent.map(overviewCard).join('')}</div>` : ''}
  </div>`
  el.scrollTop = scroll
}

function usageCell(n) {
  const d = n.data || {}
  if (n.kind === 'turn' || n.kind === 'agent' || n.kind === 'run') {
    if (d.tokensIn || d.tokensOut)
      return `${fmtTok(d.tokensIn)} → ${fmtTok(d.tokensOut)}`
    return ''
  }
  return d.outputBytes ? fmtBytes(d.outputBytes) : ''
}

function renderTree() {
  const scale = timeScale()
  $('#ticks').innerHTML = scale.ticks.map(t => `<span class="tick" style="left:${scale.pct(scale.t0 + t)}%">${fmtTick(t)}</span>`).join('')
  const grid = `<div class="grid">${scale.ticks.slice(1).map(t => `<i style="left:${scale.pct(scale.t0 + t)}%"></i>`).join('')}</div>`
  const collapsed = collapsedSet()
  const html = visibleRows().map(({ node: n, guides }) => {
    const kids = n.children?.length ?? 0
    const open = kids && !collapsed.has(n.id)
    const start = scale.pct(n.startedAt)
    const width = Math.max(scale.pct((n.endedAt ?? now())) - start, 0)
    const llm = n.kind === 'turn' && n.data?.llmMs ? Math.min(100, (n.data.llmMs / Math.max(durOf(n), 1)) * 100) : 0
    const running = isOpen(n.status)
    const desc = describe(n)
    return `<div class="row k-${n.kind}${state.selected === n.id ? ' sel' : ''}" data-id="${esc(n.id)}">
      <div class="col-name">
        <span class="guides">${guides.map(g => `<span class="g ${g}"></span>`).join('')}</span>
        <button class="chev${open ? ' open' : ''}${kids ? '' : ' leaf'}" data-toggle="${esc(n.id)}" tabindex="-1">${ICON.chev}</button>
        ${statusIcon(n.status)}
        <span class="kind">${kindIcon(n)}</span>
        <span class="label">${esc(desc.title)}</span>
        <span class="detail">${esc(desc.sub || '')}${!open && kids ? ` · ${kids} hidden` : ''}</span>
      </div>
      <div class="col-meta">${usageCell(n)}</div>
      <div class="col-dur${running ? ' s-running-text' : ''}">${fmtDur(durOf(n))}</div>
      <div class="col-time">${grid}<div class="bar c-${n.status}${running ? ' running' : ''}" style="left:${start}%;width:${width}%" title="+${fmtDur(n.startedAt - scale.t0)} · ${fmtDur(durOf(n))}">${llm ? `<span class="llm" style="width:${llm}%"></span>` : ''}</div></div>
    </div>`
  }).join('')
  $('#tree-body').innerHTML = html
}

function layoutGraph() {
  const collapsed = collapsedSet()
  const pos = new Map()
  const edges = []
  let y = 0
  let depth = 0
  const place = (node, level) => {
    depth = Math.max(depth, level)
    const kids = collapsed.has(node.id) ? [] : (node.children || [])
    let ny
    if (!kids.length) {
      ny = y
      y += GH + GY
    }
    else {
      const ys = kids.map(k => place(k, level + 1))
      ny = (ys[0] + ys[ys.length - 1]) / 2
      for (const k of kids)
        edges.push([node, k])
    }
    pos.set(node.id, { x: level * (GW + GX), y: ny, node })
    return ny
  }
  place(state.run.root, 0)
  return { pos, edges, width: (depth + 1) * (GW + GX) - GX, height: Math.max(y - GY, GH) }
}

function renderGraph() {
  const { pos, edges, width, height } = layoutGraph()
  const collapsed = collapsedSet()
  const paths = edges.map(([a, b]) => {
    const p = pos.get(a.id)
    const q = pos.get(b.id)
    const x1 = p.x + GW
    const y1 = p.y + GH / 2
    const x2 = q.x
    const y2 = q.y + GH / 2
    return `<path class="c-${b.status}" d="M${x1} ${y1}C${x1 + GX / 2} ${y1} ${x2 - GX / 2} ${y2} ${x2} ${y2}"/>`
  }).join('')
  const nodes = [...pos.values()].map(({ x, y, node: n }) => {
    const hidden = collapsed.has(n.id) ? n.children?.length ?? 0 : 0
    const desc = describe(n)
    return `<div class="gnode k-${n.kind} c-${n.status}${state.selected === n.id ? ' sel' : ''}" data-id="${esc(n.id)}" style="left:${x}px;top:${y}px" role="button" tabindex="0" aria-label="${esc(`${desc.title}: ${STATUS_LABEL[n.status]}. Show details.`)}" title="Click to see what happened">
      <div class="gn-top">${statusIcon(n.status)}<span class="kind">${kindIcon(n)}</span><span class="gn-label">${esc(desc.title)}</span><span class="gn-short">${esc(shortLabel(n))}</span><span class="gn-dur">${fmtDur(durOf(n))}</span></div>
      <div class="gn-detail">${esc(desc.sub || KIND_LABEL[n.kind])}</div>
      <div class="gn-line"></div>
      ${hidden ? `<span class="gn-more">+${hidden} more</span>` : ''}
    </div>`
  }).join('')
  const canvas = $('#graph-canvas')
  canvas.style.width = `${width}px`
  canvas.style.height = `${height}px`
  canvas.innerHTML = `<svg class="graph-edges" width="${width}" height="${height}">${paths}</svg>${nodes}`
  $('#graph-hint').classList.toggle('hidden', !!state.selected)
  if (state.graph.fittedFor !== state.runId) {
    state.graph.fittedFor = state.runId
    initialGraphView(width, height, pos.get(state.run.root.id).y)
  }
  applyTransform()
}

/** Smallest zoom a first view uses; below it the root stays in view instead of everything. */
const FIRST_VIEW_MIN = 0.3

/** Start with everything on screen when that stays legible (nodes simplify when far). */
function initialGraphView(width, height, rootY) {
  const el = $('#graph')
  const vw = el.clientWidth || 800
  const vh = el.clientHeight || 600
  const fitK = Math.min(1, (vw - 80) / Math.max(width, 1), (vh - 80) / Math.max(height, 1))
  if (fitK >= FIRST_VIEW_MIN) {
    fitGraph(width, height)
    return
  }
  state.graph.fitted = false
  state.graph.k = FIRST_VIEW_MIN
  state.graph.x = 40
  state.graph.y = Math.min(40, vh / 2 - (rootY + GH / 2) * FIRST_VIEW_MIN)
  applyTransform()
}

/**
 * Below this graph zoom, nodes drop their second line and enlarge their
 * title (counter-scaled), so a fitted overview of a big run stays readable.
 */
const FAR = 0.6

function applyTransform() {
  const g = state.graph
  const canvas = $('#graph-canvas')
  canvas.style.transform = `translate(${g.x}px, ${g.y}px) scale(${g.k})`
  canvas.classList.toggle('far', g.k < FAR)
  canvas.style.setProperty('--boost', String(Math.min(2.6, Math.max(1, 0.8 / g.k))))
  $('#zoom-level').textContent = `${Math.round(g.k * 100)}%`
}

/** Everything in view, however small that makes it. */
function fitGraph(width, height) {
  const el = $('#graph')
  if (width === undefined) {
    const canvas = $('#graph-canvas')
    width = Number.parseFloat(canvas.style.width) || 0
    height = Number.parseFloat(canvas.style.height) || 0
  }
  const vw = el.clientWidth || 800
  const vh = el.clientHeight || 600
  const k = Math.max(0.08, Math.min(1, (vw - 48) / Math.max(width, 1), (vh - 48) / Math.max(height, 1)))
  state.graph.k = k
  state.graph.x = (vw - width * k) / 2
  state.graph.y = (vh - height * k) / 2
  state.graph.fitted = true
  applyTransform()
}

function zoomAt(factor, cx, cy) {
  const g = state.graph
  const k = Math.min(3, Math.max(0.08, g.k * factor))
  g.fitted = false
  g.x = cx - (cx - g.x) * (k / g.k)
  g.y = cy - (cy - g.y) * (k / g.k)
  g.k = k
  applyTransform()
}

// -------------------------------------------------------------- inspector

function prop(label, value) {
  return value === undefined || value === '' ? '' : `<dt>${esc(label)}</dt><dd>${value}</dd>`
}

const LONG = 700

/** A titled block; long text is clipped with a "Show all" toggle. */
function section(title, text, { mono = false, tone = '', dim = false } = {}) {
  if (!text)
    return ''
  const long = text.length > LONG
  const body = `<div class="${mono ? 'code' : 'prose'}${tone ? ` ${tone}` : ''}${dim ? ' dim' : ''}${long ? ' clipped' : ''}">${esc(text)}</div>`
  return `<div class="sec"><div class="sec-head"><span>${esc(title)}</span><span class="sec-actions">${long ? '<button data-expand>Show all</button>' : ''}<button data-copy="${esc(text)}">Copy</button></span></div>${body}</div>`
}

function renderInspector() {
  const panel = $('#inspector')
  const entry = state.selected && state.index.get(state.selected)
  const wasOpen = !panel.classList.contains('hidden')
  if (!state.run || !entry) {
    panel.classList.add('hidden')
    if (wasOpen)
      afterResize()
    return
  }
  const n = entry.node
  const full = state.full.get(n.id)?.node
  const d = { ...n.data, ...(full?.data || {}) }
  const run = state.run
  const isRun = n.kind === 'run'
  const desc = describe(n)
  const has = new Set(n.has || [])
  const pending = key => has.has(key) && !d[key]
  const loading = ['task', 'text', 'output', 'error', 'thinking'].some(pending)

  let html = `
    <div class="insp-head">
      <span class="kind">${kindIcon(n)}</span>
      <span class="insp-kind">${KIND_LABEL[n.kind]}</span>
      <span class="spacer"></span>
      <button class="icon-btn" id="close-insp" title="Close (Esc)">${ICON.close}</button>
    </div>
    <div class="insp-body">
      <span class="pill c-${n.status}">${statusIcon(n.status)}${STATUS_LABEL[n.status]}</span>
      <h2 class="insp-title">${esc(isRun ? run.prompt || 'Your request' : desc.title)}</h2>
      <p class="lead">${esc(desc.sentence)} ${esc(outcomeSentence(n))}</p>`

  if (isRun)
    html += section('What you asked', run.prompt)
  html += section('What it was asked to do', d.task)
  html += section(n.kind === 'turn' ? 'What the assistant said' : 'What it said', d.text)
  if (n.kind === 'tool' || n.kind === 'agent') {
    const result = d.output && d.output !== d.error ? d.output : ''
    html += section(n.kind === 'agent' ? 'What the helper reported back' : 'What came back', result, { mono: n.kind === 'tool' })
  }
  html += section('What went wrong', d.error, { mono: true, tone: 'err' })
  if (loading)
    html += '<div class="prose dim">Loading the details…</div>'

  if (n.children?.length) {
    const heading = n.kind === 'turn' ? 'What it did next' : n.kind === 'agent' ? 'What the helper did' : n.kind === 'run' ? 'Steps' : 'Inside this action'
    html += `<div class="sec"><div class="sec-head"><span>${heading} · ${n.children.length}</span></div><div class="children-list">${n.children.slice(0, 100).map((c) => {
      const cd = describe(c)
      return `<button class="child-link" data-select="${esc(c.id)}">${statusIcon(c.status)}<span class="kind">${kindIcon(c)}</span><span class="cl-text"><span class="label">${esc(cd.title)}</span><span class="detail">${esc(cd.sub || '')}</span></span><span class="detail">${fmtDur(durOf(c))}</span></button>`
    }).join('')}</div></div>`
  }

  if (d.thinking)
    html += `<details class="more"><summary>How it reasoned</summary>${section('', d.thinking, { dim: true })}</details>`

  const tokens = d.tokensIn || d.tokensOut ? `${fmtTok(d.tokensIn)} in · ${fmtTok(d.tokensOut)} out${d.cacheRead ? ` · ${fmtTok(d.cacheRead)} cached` : ''}` : ''
  html += `<details class="more"><summary>Technical details</summary>
      <dl class="props">
        ${prop('Type', esc(n.kind === 'tool' ? `Tool call · ${d.tool || n.label}` : n.kind === 'turn' ? 'Model turn' : n.kind === 'agent' ? `Subagent · ${d.childId || n.label}, depth ${n.depth}` : 'Run'))}
        ${prop('Started', `${clockTime(n.startedAt)}${isRun ? '' : ` <span style="color:var(--text-3)">+${fmtDur(n.startedAt - run.startedAt)}</span>`}`)}
        ${prop('Duration', fmtDur(durOf(n)))}
        ${n.kind === 'turn' && d.llmMs ? prop('Model time', fmtDur(d.llmMs)) : ''}
        ${prop('Model', d.model ? esc(d.model) : '')}
        ${prop('Provider', d.provider ? esc(d.provider) : '')}
        ${prop('Tokens', tokens)}
        ${prop('Cost', d.cost ? `$${d.cost.toFixed(4)}` : '')}
        ${prop('Finish', d.finishReason ? esc(d.finishReason) : '')}
        ${prop('Output size', d.outputBytes ? fmtBytes(d.outputBytes) : '')}
        ${prop('Call id', n.kind === 'tool' ? `<code>${esc(n.id.slice(2))}</code>` : '')}
      </dl>
      ${section('Input', d.input, { mono: true })}
    </details>
    </div>`

  const body0 = panel.querySelector('.insp-body')
  const scroll = body0?.scrollTop ?? 0
  const openDetails = [...panel.querySelectorAll('details.more')].map(el => el.open)
  panel.innerHTML = html
  panel.classList.remove('hidden')
  if (!wasOpen)
    afterResize()
  if (state.inspectorFor === n.id) {
    panel.querySelectorAll('details.more').forEach((el, i) => (el.open = openDetails[i] ?? false))
    panel.querySelector('.insp-body').scrollTop = scroll
  }
  state.inspectorFor = n.id
}

// ------------------------------------------------------------------- data

async function loadRuns() {
  try {
    const data = await getJson('/api/runs')
    state.runs = data.runs
    state.sessions = data.sessions || {}
    state.label = data.label || ''
    renderGlobalBanner()
  }
  catch {
    return
  }
  // Deep links: ?run=<id> or ?session=<id> (that conversation's newest request, once it has one).
  if (state.pendingRun) {
    const id = state.pendingRun
    state.pendingRun = null
    if (state.runs.some(r => r.id === id)) {
      await selectRun(id)
      return
    }
  }
  if (state.pendingSession) {
    const newest = newestOf(state.pendingSession)
    if (newest) {
      state.pendingSession = null
      await selectRun(newest.id)
      return
    }
  }
  // Follow stays inside the open conversation: other sessions starting
  // requests never pull the view away.
  if (state.follow && state.runId) {
    const current = state.runs.find(r => r.id === state.runId)
    const newest = current && newestOf(current.sessionId)
    if (newest && newest.id !== state.runId) {
      await selectRun(newest.id)
      return
    }
  }
  renderSidebar()
  renderHeader()
  if (!state.runId)
    renderOverview()
}

async function loadRun() {
  if (!state.runId)
    return
  try {
    const data = await getJson(`/api/runs/${encodeURIComponent(state.runId)}`)
    state.run = data.run
    indexRun(state.run)
    if (state.selected && !state.index.has(state.selected))
      state.selected = null
  }
  catch {
    state.run = null
  }
  renderHeader()
  renderMain()
  renderInspector()
  if (state.selected && isOpen(state.index.get(state.selected)?.node.status))
    refreshNode()
}

const loadNode = async () => {
  const id = state.selected
  const runId = state.runId
  if (!id || !runId || id === state.run?.root.id)
    return
  try {
    const data = await getJson(`/api/runs/${encodeURIComponent(runId)}/nodes/${encodeURIComponent(id)}`)
    state.full.set(id, { node: data.node })
    if (state.selected === id)
      renderInspector()
  }
  catch {}
}

const refreshRuns = throttle(loadRuns, 400)
const refreshRun = throttle(loadRun, 180)
const refreshNode = throttle(loadNode, 500)

/** Open a request (`null`: the Live now overview). Following is on when it is its conversation's newest. */
async function selectRun(id) {
  if (id !== state.runId) {
    state.selected = null
    state.full.clear()
  }
  state.runId = id
  const url = new URL(location.href)
  url.searchParams.delete('session')
  if (id) {
    const summary = state.runs.find(r => r.id === id)
    state.follow = !summary || newestOf(summary.sessionId)?.id === id
    url.searchParams.set('run', id)
  }
  else {
    state.run = null
    url.searchParams.delete('run')
  }
  history.replaceState(null, '', url)
  if (!id) {
    render()
    return
  }
  renderSidebar()
  await loadRun()
}

function select(id, { scroll = false } = {}) {
  state.selected = id
  renderHeader()
  if (state.view === 'tree') {
    document.querySelectorAll('#tree-body .row.sel').forEach(r => r.classList.remove('sel'))
    const row = document.querySelector(`#tree-body .row[data-id="${CSS.escape(id)}"]`)
    row?.classList.add('sel')
    if (scroll)
      row?.scrollIntoView({ block: 'nearest' })
  }
  else {
    const focused = document.activeElement?.closest?.('.gnode')?.dataset.id
    renderGraph()
    if (focused)
      document.querySelector(`.gnode[data-id="${CSS.escape(focused)}"]`)?.focus({ preventScroll: true })
  }
  renderInspector()
  if (id && !state.full.has(id))
    loadNode()
}

function toggle(id, open) {
  const set = collapsedSet()
  const entry = state.index.get(id)
  if (!entry?.node.children?.length)
    return
  const shouldOpen = open ?? set.has(id)
  if (shouldOpen)
    set.delete(id)
  else
    set.add(id)
  renderMain()
}

function connect() {
  const es = new EventSource('/api/events')
  const live = (online) => {
    if (online === state.online)
      return
    state.online = online
    state.offlineAt = online ? null : Date.now() + state.skew
    $('#live').classList.toggle('on', online)
    $('#live span').textContent = online ? 'Live' : 'Not connected'
    $('#app').classList.toggle('offline', !online)
    renderGlobalBanner()
    render()
  }
  es.addEventListener('hello', () => {
    live(true)
    refreshRuns()
    refreshRun()
  })
  es.addEventListener('change', (event) => {
    const { runs } = JSON.parse(event.data)
    refreshRuns()
    if (runs.some(r => r.id === state.runId)) {
      refreshRun()
      if (state.selected)
        refreshNode()
    }
  })
  es.addEventListener('appearance', (event) => {
    appearance.zidane = JSON.parse(event.data).appearance ?? null
    applyAppearance()
  })
  es.onerror = () => live(false)
}

$('#toggle-sidebar').addEventListener('click', toggleSidebar)
$('#fit-screen').addEventListener('click', () => fitGraph())
$('#crumbs').addEventListener('click', (event) => {
  if (event.target.closest('[data-overview]'))
    selectRun(null)
})
$('#runbar').addEventListener('click', (event) => {
  if (event.target.closest('[data-toggle-header]'))
    toggleHeader()
})
window.addEventListener('resize', () => {
  applyLayout()
  afterResize()
})
$('#zoom-out-page').addEventListener('click', () => zoomBy(-1))
$('#zoom-in-page').addEventListener('click', () => zoomBy(1))
$('#zoom-pct').addEventListener('click', () => setZoom(null))
$('#appearance').addEventListener('click', (event) => {
  const pick = event.target.closest('[data-theme-pick]')?.dataset.themePick
  if (!pick)
    return
  appearance.pref = pick
  localStorage.setItem('agent-flow.theme', pick)
  applyAppearance()
})
osDark.addEventListener('change', applyAppearance)

// ----------------------------------------------------------------- events

function onRowPointer(event) {
  if (event.button !== 0)
    return
  const toggleBtn = event.target.closest('[data-toggle]')
  if (toggleBtn) {
    event.preventDefault()
    toggle(toggleBtn.dataset.toggle)
    return
  }
  const row = event.target.closest('[data-id]')
  if (row)
    select(row.dataset.id)
}

$('#tree-body').addEventListener('pointerdown', onRowPointer)
$('#tree-body').addEventListener('dblclick', (event) => {
  const row = event.target.closest('[data-id]')
  if (row && !event.target.closest('[data-toggle]'))
    toggle(row.dataset.id)
})

// Lists re-render while sessions stream; act on pointerdown so a click is never lost to a re-render.
$('#runs').addEventListener('pointerdown', (event) => {
  if (event.button !== 0)
    return
  const more = event.target.closest('[data-expand-session]')
  if (more) {
    const sid = more.dataset.expandSession
    if (!state.expandedSessions.delete(sid))
      state.expandedSessions.add(sid)
    renderSidebar()
    return
  }
  const item = event.target.closest('[data-run]')
  if (item)
    selectRun(item.dataset.run)
})
$('#overview').addEventListener('pointerdown', (event) => {
  const card = event.button === 0 && event.target.closest('[data-run]')
  if (card)
    selectRun(card.dataset.run)
})
$('#overview').addEventListener('keydown', (event) => {
  const card = (event.key === 'Enter' || event.key === ' ') && event.target.closest('[data-run]')
  if (card) {
    event.preventDefault()
    event.stopPropagation()
    selectRun(card.dataset.run)
  }
})
$('#live-now').addEventListener('click', () => selectRun(null))
$('#runbar').addEventListener('click', (event) => {
  const item = event.target.closest('[data-run]')
  if (item)
    selectRun(item.dataset.run)
})

$('#follow').addEventListener('click', () => setFollow(!state.follow))
function setFollow(on) {
  state.follow = on
  renderSidebar()
  if (on)
    loadRuns()
}


$('#search').addEventListener('input', (event) => {
  state.filter = event.target.value
  renderSidebar()
  if (!state.runId)
    renderOverview()
})

$('#views').addEventListener('click', (event) => {
  const btn = event.target.closest('[data-view]')
  if (btn)
    setView(btn.dataset.view)
})
function setView(view) {
  state.view = view
  localStorage.setItem('agent-flow.view', view)
  if (view === 'graph' && state.run)
    state.graph.fittedFor = null
  renderMain()
}

$('#expand-all').addEventListener('click', () => {
  collapsedSet().clear()
  renderMain()
})
$('#collapse-all').addEventListener('click', () => {
  const set = collapsedSet()
  for (const { node } of state.index.values()) {
    if (node.kind !== 'run' && node.children?.length)
      set.add(node.id)
  }
  renderMain()
})

$('#inspector').addEventListener('click', (event) => {
  if (event.target.closest('#close-insp')) {
    select(null)
    return
  }
  const expand = event.target.closest('[data-expand]')
  if (expand) {
    const box = expand.closest('.sec').querySelector('.clipped, .unclipped')
    const clipped = box.classList.toggle('clipped')
    box.classList.toggle('unclipped', !clipped)
    expand.textContent = clipped ? 'Show all' : 'Show less'
    return
  }
  const copy = event.target.closest('[data-copy]')
  if (copy) {
    navigator.clipboard?.writeText(copy.dataset.copy)
    copy.textContent = 'Copied'
    setTimeout(() => (copy.textContent = 'Copy'), 1200)
    return
  }
  const link = event.target.closest('[data-select]')
  if (link) {
    const id = link.dataset.select
    // Reveal it: open its ancestors.
    let parent = state.index.get(id)?.parent
    while (parent) {
      collapsedSet().delete(parent.id)
      parent = state.index.get(parent.id)?.parent
    }
    renderMain()
    select(id, { scroll: true })
  }
})

// Graph: drag to pan, pinch / ctrl+wheel to zoom, wheel to scroll.
const graphEl = $('#graph')
let drag = null
graphEl.addEventListener('pointerdown', (event) => {
  if (event.button !== 0 || event.target.closest('.graph-controls'))
    return
  const node = event.target.closest('.gnode')
  if (node) {
    select(node.dataset.id)
    return
  }
  drag = { x: event.clientX, y: event.clientY, ox: state.graph.x, oy: state.graph.y, z: pageZoom() }
  graphEl.setPointerCapture(event.pointerId)
  graphEl.classList.add('dragging')
})
graphEl.addEventListener('pointermove', (event) => {
  if (!drag)
    return
  state.graph.x = drag.ox + (event.clientX - drag.x) / drag.z
  state.graph.y = drag.oy + (event.clientY - drag.y) / drag.z
  state.graph.fitted = false
  applyTransform()
})
const endDrag = () => {
  drag = null
  graphEl.classList.remove('dragging')
}
graphEl.addEventListener('pointerup', endDrag)
graphEl.addEventListener('pointercancel', endDrag)
graphEl.addEventListener('dblclick', (event) => {
  const node = event.target.closest('.gnode')
  if (node)
    toggle(node.dataset.id)
})
graphEl.addEventListener('wheel', (event) => {
  event.preventDefault()
  const rect = graphEl.getBoundingClientRect()
  const z = pageZoom()
  if (event.ctrlKey || event.metaKey) {
    zoomAt(Math.exp(-event.deltaY * 0.01), (event.clientX - rect.left) / z, (event.clientY - rect.top) / z)
  }
  else {
    state.graph.x -= event.deltaX / z
    state.graph.y -= event.deltaY / z
    state.graph.fitted = false
    applyTransform()
  }
}, { passive: false })
const center = () => [graphEl.clientWidth / 2, graphEl.clientHeight / 2]
$('#zoom-in').addEventListener('click', () => zoomAt(1.2, ...center()))
$('#zoom-out').addEventListener('click', () => zoomAt(1 / 1.2, ...center()))
$('#fit').addEventListener('click', () => fitGraph())

document.addEventListener('keydown', (event) => {
  if ((event.metaKey || event.ctrlKey) && !event.altKey && ['=', '+', '-', '_', '0'].includes(event.key)) {
    event.preventDefault()
    if (event.key === '0')
      setZoom(null)
    else
      zoomBy(event.key === '-' || event.key === '_' ? -1 : 1)
    return
  }
  if (event.metaKey || event.ctrlKey || event.altKey)
    return
  if (event.target.matches('input, textarea')) {
    if (event.key === 'Escape')
      event.target.blur()
    return
  }
  const focusedNode = event.target.closest?.('.gnode')
  if (focusedNode && (event.key === 'Enter' || event.key === ' ')) {
    event.preventDefault()
    select(focusedNode.dataset.id)
    return
  }
  const rows = visibleRows()
  const at = rows.findIndex(r => r.node.id === state.selected)
  const move = (delta) => {
    const next = rows[Math.min(rows.length - 1, Math.max(0, at < 0 ? 0 : at + delta))]
    if (next)
      select(next.node.id, { scroll: true })
  }
  const current = at >= 0 ? rows[at].node : null
  switch (event.key) {
    case 'j':
    case 'ArrowDown':
      move(1)
      break
    case 'k':
    case 'ArrowUp':
      move(-1)
      break
    case 'l':
    case 'ArrowRight':
      if (current?.children?.length) {
        if (collapsedSet().has(current.id))
          toggle(current.id, true)
        else
          move(1)
      }
      break
    case 'h':
    case 'ArrowLeft':
      if (current?.children?.length && !collapsedSet().has(current.id)) {
        toggle(current.id, false)
      }
      else if (current) {
        const parent = state.index.get(current.id)?.parent
        if (parent)
          select(parent.id, { scroll: true })
      }
      break
    case 'Enter':
    case ' ':
      if (current)
        toggle(current.id)
      break
    case 'Escape':
      if (state.selected)
        select(null)
      else if (state.runId)
        selectRun(null)
      break
    case 'o':
      selectRun(null)
      break
    case 's':
      toggleSidebar()
      break
    case 'g':
      setView(state.view === 'tree' ? 'graph' : 'tree')
      break
    case 'f':
      if (state.runId)
        setFollow(!state.follow)
      break
    case '0':
      if (state.view === 'graph')
        fitGraph()
      break
    case '=':
    case '+':
      if (state.view === 'graph')
        zoomAt(1.2, ...center())
      break
    case '-':
      if (state.view === 'graph')
        zoomAt(1 / 1.2, ...center())
      break
    case '/':
      $('#search').focus()
      break
    case '[':
    case ']': {
      const i = state.runs.findIndex(r => r.id === state.runId)
      const next = i < 0 ? state.runs[0] : state.runs[i + (event.key === ']' ? -1 : 1)]
      if (next)
        selectRun(next.id)
      break
    }
    default:
      return
  }
  event.preventDefault()
})

// Live clock for running runs.
setInterval(() => {
  if (!state.runId) {
    renderOverview()
    renderSidebar()
  }
  else if (state.run && isOpen(state.run.status)) {
    renderHeader()
    if (state.view === 'tree')
      renderTree()
    else
      renderGraph()
  }
  else if (state.runs.length) {
    renderSidebar()
  }
}, 1000)

applyAppearance()
render()
connect()
loadRuns()
loadAppearance()
