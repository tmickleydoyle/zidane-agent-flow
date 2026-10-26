/**
 * Agent Flow — a live view of how the agent works.
 *
 * Every run becomes a tree (Run → Turn → Tool call → Subagent → its turns
 * and tools), recorded from the agent's hooks. A local web UI shows it as an
 * Airflow-style tree with a timeline, or as a graph, in a Linear-style
 * interface. The side panel ("Flow") shows the session's latest run and
 * links to the full view; `/flow` and the command palette open it too.
 *
 * Install: put (or symlink) this folder at `~/.zidane/extensions/agent-flow/`.
 */
import type { ExtensionContext, ExtensionDefinition } from 'zidane'
import type { FlowServer } from './src/server'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { createDesktopAppearanceProbe } from './src/appearance'
import { registerFlowHooks } from './src/hooks'
import { openInBrowser } from './src/open'
import { buildPanel } from './src/panel'
import { createPeerDirectory, hostKind } from './src/peers'
import { startFlowServer } from './src/server'
import { FlowStore } from './src/store'

const NAME = 'agent-flow'
const VERSION = '0.2.0'
const DEFAULT_PORT = 7428
/** Save soon after a run ends; while runs stream, at most this often. */
const SAVE_AFTER_END_MS = 1000
const SAVE_WHILE_RUNNING_MS = 10_000
/** The Flow panel shows statuses and durations: once a second is enough, however many sessions stream. */
const PANEL_REFRESH_MS = 1000

/**
 * One store and one server per process, shared by every registry the host
 * builds: the desktop app builds one per project, each with its own import
 * of this module. A different `token` (another version) takes over and
 * carries the runs across.
 */
interface Shared {
  token: string
  store: FlowStore
  server?: FlowServer
  starting?: Promise<FlowServer | undefined>
  refs: number
  save?: () => void
  stopSaving?: () => void
  unregisterPeer?: () => void
}

/** Bump the suffix when the store's shape changes. */
const TOKEN = `${NAME}@${VERSION}#1`
const SHARED_KEY = Symbol.for('zidane-agent-flow.shared')
const globalSlot = globalThis as unknown as Record<symbol, Shared | undefined>

function uiDir(ctx: ExtensionContext): string {
  const base = ctx.dir ?? dirname(fileURLToPath(import.meta.url))
  return join(base, 'ui')
}

async function loadPersisted(store: FlowStore, file: string): Promise<void> {
  try {
    store.hydrate(JSON.parse(await readFile(file, 'utf8')))
  }
  catch {
    // First start, or an unreadable file: start empty.
  }
}

function startSaving(store: FlowStore, file: string): { save: () => void, stop: () => void } {
  let timer: ReturnType<typeof setTimeout> | undefined
  let due = Infinity
  const write = async (): Promise<void> => {
    timer = undefined
    due = Infinity
    try {
      await mkdir(dirname(file), { recursive: true })
      await writeFile(file, JSON.stringify(store.serialize()))
    }
    catch {}
  }
  /** Schedule a write within `delay`, moving an already scheduled one earlier if needed. */
  const schedule = (delay: number): void => {
    const at = Date.now() + delay
    if (at >= due)
      return
    if (timer)
      clearTimeout(timer)
    due = at
    timer = setTimeout(() => void write(), delay)
  }
  const save = (): void => schedule(SAVE_WHILE_RUNNING_MS)
  const unsubscribe = store.subscribe((runId) => {
    const status = store.getRun(runId)?.status
    schedule(status === 'running' || status === 'queued' ? SAVE_WHILE_RUNNING_MS : SAVE_AFTER_END_MS)
  })
  return {
    save,
    stop: () => {
      unsubscribe()
      if (timer) {
        clearTimeout(timer)
        void write()
      }
    },
  }
}

async function acquire(ctx: ExtensionContext): Promise<Shared> {
  const existing = globalSlot[SHARED_KEY]
  if (existing && existing.token === TOKEN) {
    existing.refs++
    return existing
  }

  const store = new FlowStore()
  const persist = ctx.config.get('persist') !== false
  // One history per kind of process: the desktop app, the daemon and the
  // terminal each record their own runs, and must not overwrite each other.
  const file = ctx.storage.path('data', `runs-${hostKind()}.json`)
  const peers = createPeerDirectory()

  if (existing) {
    // A reload: carry the previous code's runs over, then retire it.
    store.hydrate(existing.store.serialize())
    existing.stopSaving?.()
    existing.unregisterPeer?.()
    globalSlot[SHARED_KEY] = undefined
    await (existing.server ?? await existing.starting)?.close().catch(() => {})
  }
  else if (persist) {
    await loadPersisted(store, file)
  }

  const shared: Shared = { token: TOKEN, store, refs: 1 }
  if (persist) {
    const saving = startSaving(store, file)
    shared.save = saving.save
    shared.stopSaving = saving.stop
  }
  const configured = Number(ctx.config.get('port'))
  const port = Number.isInteger(configured) && configured >= 0 && configured <= 65535 ? configured : DEFAULT_PORT
  shared.starting = startFlowServer({
    store,
    uiDir: uiDir(ctx),
    port,
    peers,
    appearance: createDesktopAppearanceProbe(),
    sessionTitles: async () => {
      const list = await ctx.sessions.list()
      return Object.fromEntries(list.filter(s => s.title).map(s => [s.id, s.title!]))
    },
  }).then((server) => {
    shared.server = server
    peers.register(server.port)
    shared.unregisterPeer = () => peers.unregister()
    ctx.logger.info(`agent-flow: visualizer at ${server.url} (${hostKind()})`)
    return server
  }).catch((error: unknown) => {
    ctx.logger.warn('agent-flow: could not start the visualizer server', { error: error instanceof Error ? error.message : String(error) })
    return undefined
  })
  globalSlot[SHARED_KEY] = shared
  return shared
}

async function release(shared: Shared): Promise<void> {
  shared.refs--
  if (shared.refs > 0 || globalSlot[SHARED_KEY] !== shared)
    return
  globalSlot[SHARED_KEY] = undefined
  shared.stopSaving?.()
  shared.unregisterPeer?.()
  await (shared.server ?? await shared.starting)?.close().catch(() => {})
}

/**
 * Releases owed by this module's setups. The host awaits `teardown()` once
 * per disposed registry; each setup holds one lease.
 */
const leases: Array<() => Promise<void>> = []

function lease(shared: Shared): void {
  let done = false
  leases.push(async () => {
    if (done)
      return
    done = true
    await release(shared)
  })
}

function sessionUrl(base: string, sessionId?: string): string {
  return sessionId ? `${base}?session=${encodeURIComponent(sessionId)}` : base
}

const definition: ExtensionDefinition = {
  name: NAME,
  displayName: 'Agent Flow',
  version: VERSION,
  description: 'Live tree, timeline and graph of how the agent works: runs, turns, tool calls and subagents.',
  capabilities: ['hooks', 'storage'],
  async setup(ctx) {
    ctx.registerConfigItem({
      key: 'port',
      type: 'number',
      label: 'Visualizer port',
      description: 'Local port of the web view (127.0.0.1). A taken port falls back to a free one.',
      default: DEFAULT_PORT,
      min: 0,
      max: 65535,
      onChange: 'restart',
    })
    ctx.registerConfigItem({
      key: 'persist',
      type: 'boolean',
      label: 'Keep history',
      description: 'Save recent runs so they survive restarts.',
      default: true,
      onChange: 'restart',
    })

    // Disabled: declare the config schema only.
    if (ctx.disabled)
      return

    const shared = await acquire(ctx)
    const { store } = shared
    const url = async (): Promise<string | undefined> => (shared.server ?? await shared.starting)?.url

    lease(shared)

    registerFlowHooks(ctx, store)
    // Backstop (desktop app, daemon): the host says this conversation's request
    // settled, so nothing in it is running, whether or not zidane sent the
    // run's end event (it does not when a run's setup fails).
    ctx.registerRunSettled(({ sessionId }) => {
      store.closeSession(sessionId)
    })

    ctx.registerConfigItem({
      key: 'open',
      type: 'action',
      label: 'Open visualizer',
      run: async () => {
        const base = await url()
        if (!base)
          throw new Error('The visualizer server is not running.')
        openInBrowser(base)
        return { message: `opened ${base}` }
      },
      status: async () => {
        const base = await url()
        return base ? { state: 'ok', message: `running at ${base}` } : { state: 'error', message: 'not running' }
      },
    })

    ctx.registerPanel({
      id: 'flow',
      label: 'Flow',
      icon: { gui: 'i-ph-git-merge', tui: '⑂' },
      scope: 'both',
      // This process's run, else a peer's: with "use daemon" on, the desktop
      // app paints panels while the runs happen in the daemon.
      load: async ({ sessionId }) => {
        const server = shared.server ?? await shared.starting
        const own = store.latestRun(sessionId) ?? (sessionId ? undefined : store.latestRun())
        const run = own ?? await server?.remoteLatestRun(sessionId)
        return buildPanel(run, server?.url)
      },
      subscribe: (emit) => {
        let timer: ReturnType<typeof setTimeout> | undefined
        const schedule = (): void => {
          timer ??= setTimeout(() => {
            timer = undefined
            emit()
          }, PANEL_REFRESH_MS)
        }
        const unsubscribe = store.subscribe(schedule)
        let unsubscribeRemote: (() => void) | undefined
        let closed = false
        void (async () => {
          const server = shared.server ?? await shared.starting
          if (!closed && server)
            unsubscribeRemote = server.onRemoteChange(schedule)
        })()
        return () => {
          closed = true
          unsubscribe()
          unsubscribeRemote?.()
          if (timer)
            clearTimeout(timer)
        }
      },
      onAction: async (actionId, _payload, { sessionId }) => {
        const base = await url()
        if (actionId === 'open' && base)
          openInBrowser(sessionUrl(base, sessionId))
      },
    })

    ctx.registerCommand({
      name: 'flow',
      description: 'Open the Agent Flow visualizer',
      async run(step) {
        const base = await url()
        if (!base) {
          step.emit({ text: 'Agent Flow: the visualizer server is not running (see the logs).' })
          return
        }
        const target = sessionUrl(base, step.session?.id)
        openInBrowser(target)
        step.emit({ text: `Agent Flow: [${target}](${target})` })
      },
    })

    ctx.registerPaletteCommand({
      id: 'open',
      title: 'Open Agent Flow',
      description: 'Tree, timeline and graph of the agent’s work',
      keywords: ['flow', 'graph', 'tree', 'visualize', 'trace', 'timeline'],
      icon: { gui: 'i-ph-git-merge', tui: '⑂' },
      run: async () => {
        const base = await url()
        if (!base)
          return { kind: 'notify', text: 'Agent Flow: the visualizer server is not running.', tone: 'error' }
        openInBrowser(base)
        return { kind: 'notify', text: `Agent Flow opened at ${base}` }
      },
    })
  },
  async teardown() {
    await leases.shift()?.()
  },
}

export default definition
