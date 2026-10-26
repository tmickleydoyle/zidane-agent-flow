import type { IncomingMessage, Server, ServerResponse } from 'node:http'
import type { ZidaneAppearance } from './appearance'
import type { PeerInfo } from './peers'
import type { FlowNode, FlowRun, FlowStore, RunSummary } from './store'
import { readFile } from 'node:fs/promises'
import { createServer } from 'node:http'
import { extname, join, normalize } from 'node:path'

export interface FlowServerOptions {
  store: FlowStore
  /** Directory holding `index.html`, `app.js`, `styles.css`. */
  uiDir: string
  port: number
  host?: string
  /** Session titles for the sidebar; failures fall back to ids. */
  sessionTitles?: () => Promise<Record<string, string>>
  /** Debounce between store changes and SSE pushes. */
  pushDelayMs?: number
  /** zidane's live appearance (desktop app), polled while a viewer is connected. */
  appearance?: () => Promise<ZidaneAppearance | undefined>
  appearancePollMs?: number
  /** Shown above everything, e.g. that the data is a demo. */
  label?: string
  /**
   * Other processes running this extension (the daemon next to the desktop
   * app). Their runs are shown alongside this process's own.
   */
  peers?: { list: () => PeerInfo[] }
  /** How often the peer list is re-read while something is listening. */
  peerSyncMs?: number
}

export interface FlowServer {
  url: string
  port: number
  close: () => Promise<void>
  /** Called when a peer process reports a change. Returns an unsubscribe. */
  onRemoteChange: (listener: () => void) => () => void
  /** The newest run of a session (or overall) held by a peer, as a lite tree. */
  remoteLatestRun: (sessionId?: string) => Promise<FlowRun | undefined>
}

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.json': 'application/json; charset=utf-8',
}

const STATIC = new Set(['index.html', 'app.js', 'styles.css', 'favicon.svg'])

const HEAVY = ['input', 'output', 'text', 'thinking', 'task', 'error'] as const
const PREVIEW_CHARS = 240

/**
 * The tree without its heavy text: the UI refetches it on every change, and
 * asks for one node's full data when it is selected.
 */
export function liteNode(node: FlowNode): FlowNode & { has: string[] } {
  const data: Record<string, unknown> = {}
  const has: string[] = []
  for (const [key, value] of Object.entries(node.data)) {
    if ((HEAVY as readonly string[]).includes(key)) {
      if (typeof value === 'string' && value) {
        has.push(key)
        if (key === 'error')
          data.error = value.slice(0, PREVIEW_CHARS)
      }
      continue
    }
    data[key] = value
  }
  return { ...node, data, has, children: node.children.map(liteNode) }
}

export function liteRun(run: FlowRun): FlowRun {
  return { ...run, root: liteNode(run.root) }
}

function send(res: ServerResponse, status: number, body: string, type = 'text/plain; charset=utf-8'): void {
  res.writeHead(status, { 'content-type': type, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' })
  res.end(body)
}

function json(res: ServerResponse, value: unknown): void {
  send(res, 200, JSON.stringify(value), MIME['.json'])
}

/**
 * Only answer requests addressed to this loopback server, so a web page in
 * another tab cannot read the agent's tool inputs through DNS rebinding.
 */
function allowedHost(req: IncomingMessage, port: number): boolean {
  const host = req.headers.host
  if (!host)
    return false
  return host === `127.0.0.1:${port}` || host === `localhost:${port}` || host === `[::1]:${port}`
}

function listen(server: Server, port: number, host: string): Promise<number> {
  return new Promise((resolve, reject) => {
    const onError = (error: Error): void => {
      server.off('listening', onListening)
      reject(error)
    }
    const onListening = (): void => {
      server.off('error', onError)
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : port)
    }
    server.once('error', onError)
    server.once('listening', onListening)
    server.listen(port, host)
  })
}

const PEER_TIMEOUT_MS = 1500

async function peerJson<T>(peer: PeerInfo, path: string): Promise<T | undefined> {
  try {
    const res = await fetch(`http://127.0.0.1:${peer.port}${path}`, { signal: AbortSignal.timeout(PEER_TIMEOUT_MS) })
    return res.ok ? await res.json() as T : undefined
  }
  catch {
    return undefined
  }
}

/** Same run seen twice (two processes sharing history): keep the live or most recent view. */
function better(a: RunSummary, b: RunSummary): RunSummary {
  const open = (r: RunSummary) => r.status === 'running' || r.status === 'queued'
  if (open(a) !== open(b))
    return open(a) ? a : b
  return (b.lastEventAt ?? b.endedAt ?? b.startedAt) > (a.lastEventAt ?? a.endedAt ?? a.startedAt) ? b : a
}

interface Client {
  res: ServerResponse
  /** A peer's relay subscription: only this process's own changes. */
  local: boolean
}

export async function startFlowServer(options: FlowServerOptions): Promise<FlowServer> {
  const { store, uiDir } = options
  const host = options.host ?? '127.0.0.1'
  const clients = new Set<Client>()
  const pending = new Set<string>()
  const remoteListeners = new Set<() => void>()
  let timer: ReturnType<typeof setTimeout> | undefined
  let port = 0

  const broadcast = (payload: string, onlyFederated = false): void => {
    for (const client of clients) {
      if (!onlyFederated || !client.local)
        client.res.write(payload)
    }
  }

  const flush = (): void => {
    timer = undefined
    const runs = [...pending]
    pending.clear()
    if (runs.length === 0)
      return
    broadcast(`event: change\ndata: ${JSON.stringify({ runs: runs.map(id => ({ id, version: store.getRun(id)?.version ?? 0 })) })}\n\n`)
  }

  const unsubscribe = store.subscribe((runId) => {
    pending.add(runId)
    timer ??= setTimeout(flush, options.pushDelayMs ?? 120)
  })

  const heartbeat = setInterval(() => {
    for (const client of clients)
      client.res.write(': ping\n\n')
  }, 15_000)
  heartbeat.unref?.()

  // ------------------------------------------------------------ peers

  const peers = (): PeerInfo[] => {
    try {
      return options.peers?.list() ?? []
    }
    catch {
      return []
    }
  }

  const peerRuns = async (): Promise<{ runs: RunSummary[], sessions: Record<string, string> }> => {
    const answers = await Promise.all(peers().map(peer => peerJson<{ runs?: RunSummary[], sessions?: Record<string, string> }>(peer, '/api/runs?local=1')))
    const runs: RunSummary[] = []
    const sessions: Record<string, string> = {}
    for (const answer of answers) {
      runs.push(...(answer?.runs ?? []))
      Object.assign(sessions, answer?.sessions ?? {})
    }
    return { runs, sessions }
  }

  /** First peer that answers `path` (each peer only answers for its own runs). */
  const fromPeers = async <T>(path: string): Promise<T | undefined> => {
    const answers = await Promise.all(peers().map(peer => peerJson<T>(peer, path)))
    return answers.find(answer => answer !== undefined)
  }

  // Upstream relay: a peer's own changes, forwarded to this server's viewers
  // (and to the Flow panel). Peers are read with ?local=1, so nothing loops.
  const upstreams = new Map<string, AbortController>()
  const relayActive = (): boolean => remoteListeners.size > 0 || [...clients].some(c => !c.local)

  const connectUpstream = (peer: PeerInfo, key: string): void => {
    const controller = new AbortController()
    upstreams.set(key, controller)
    void (async () => {
      try {
        const res = await fetch(`http://127.0.0.1:${peer.port}/api/events?local=1`, { signal: controller.signal })
        if (!res.ok || !res.body)
          return
        const reader = res.body.getReader()
        const decoder = new TextDecoder()
        let buffer = ''
        for (;;) {
          const { value, done } = await reader.read()
          if (done)
            break
          buffer += decoder.decode(value, { stream: true })
          let end = buffer.indexOf('\n\n')
          while (end >= 0) {
            const block = buffer.slice(0, end)
            buffer = buffer.slice(end + 2)
            end = buffer.indexOf('\n\n')
            const event = /^event: (.+)$/m.exec(block)?.[1]
            if (event === 'change' || event === 'hello') {
              broadcast(`event: change\ndata: ${event === 'change' ? (/^data: (.*)$/m.exec(block)?.[1] ?? '{"runs":[]}') : '{"runs":[]}'}\n\n`, true)
              for (const listener of remoteListeners)
                listener()
            }
          }
        }
      }
      catch {}
      finally {
        if (upstreams.get(key) === controller) {
          upstreams.delete(key)
          // The peer went away (or restarted): its runs leave the list.
          broadcast('event: change\ndata: {"runs":[]}\n\n', true)
          for (const listener of remoteListeners)
            listener()
        }
      }
    })()
  }

  const syncUpstreams = (): void => {
    if (!options.peers)
      return
    if (!relayActive()) {
      for (const controller of upstreams.values())
        controller.abort()
      upstreams.clear()
      return
    }
    const live = new Set<string>()
    for (const peer of peers()) {
      const key = `${peer.pid}:${peer.port}`
      live.add(key)
      if (!upstreams.has(key))
        connectUpstream(peer, key)
    }
    for (const [key, controller] of upstreams) {
      if (!live.has(key)) {
        upstreams.delete(key)
        controller.abort()
      }
    }
  }
  const peerTimer = options.peers ? setInterval(syncUpstreams, options.peerSyncMs ?? 3000) : undefined
  peerTimer?.unref?.()

  // ------------------------------------------------------- appearance

  /** This process's probe; for viewers, a peer's when this process has none (the daemon serving the page). */
  const appearanceFor = async (local: boolean): Promise<ZidaneAppearance | undefined> => {
    const own = await options.appearance?.().catch(() => undefined)
    if (own || local)
      return own
    return (await fromPeers<{ appearance: ZidaneAppearance | null }>('/api/appearance?local=1'))?.appearance ?? undefined
  }

  // Theme switches in zidane reach open viewers within a poll.
  const lastAppearance = { local: '', federated: '' }
  const appearanceTimer = (options.appearance || options.peers)
    ? setInterval(async () => {
      for (const local of [true, false]) {
        if (![...clients].some(c => c.local === local))
          continue
        const encoded = JSON.stringify({ appearance: (await appearanceFor(local)) ?? null })
        const slot = local ? 'local' : 'federated'
        if (encoded === lastAppearance[slot])
          continue
        lastAppearance[slot] = encoded
        for (const client of clients) {
          if (client.local === local)
            client.res.write(`event: appearance\ndata: ${encoded}\n\n`)
        }
      }
    }, options.appearancePollMs ?? 2000)
    : undefined
  appearanceTimer?.unref?.()

  const server = createServer(async (req, res) => {
    try {
      if (!allowedHost(req, port)) {
        send(res, 403, 'Forbidden')
        return
      }
      const url = new URL(req.url ?? '/', `http://${req.headers.host}`)
      const path = url.pathname
      const local = url.searchParams.get('local') === '1'

      if (req.method !== 'GET') {
        send(res, 405, 'Method not allowed')
        return
      }

      if (path === '/api/events') {
        res.writeHead(200, {
          'content-type': 'text/event-stream',
          'cache-control': 'no-store',
          'connection': 'keep-alive',
        })
        res.write(`event: hello\ndata: ${JSON.stringify({ now: Date.now() })}\n\n`)
        const client: Client = { res, local }
        clients.add(client)
        req.on('close', () => {
          clients.delete(client)
          syncUpstreams()
        })
        syncUpstreams()
        return
      }

      if (path === '/api/appearance') {
        json(res, { now: Date.now(), appearance: (await appearanceFor(local)) ?? null })
        return
      }

      if (path === '/api/runs') {
        let titles: Record<string, string> = {}
        try {
          titles = (await options.sessionTitles?.()) ?? {}
        }
        catch {}
        let runs = store.listRuns()
        if (!local && options.peers) {
          const remote = await peerRuns()
          const byId = new Map(runs.map(r => [r.id, r]))
          for (const run of remote.runs) {
            const mine = byId.get(run.id)
            byId.set(run.id, mine ? better(mine, run) : run)
          }
          runs = [...byId.values()].sort((a, b) => b.startedAt - a.startedAt)
          titles = { ...remote.sessions, ...titles }
        }
        json(res, { now: Date.now(), runs, sessions: titles, ...(options.label ? { label: options.label } : {}) })
        return
      }

      const nodeMatch = /^\/api\/runs\/([^/]+)\/nodes\/([^/]+)$/.exec(path)
      if (nodeMatch) {
        const node = store.getNode(decodeURIComponent(nodeMatch[1]!), decodeURIComponent(nodeMatch[2]!))
        if (node) {
          json(res, { now: Date.now(), node: { ...node, children: undefined, childCount: node.children.length } })
          return
        }
        const remote = local ? undefined : await fromPeers<{ node: unknown }>(`${path}?local=1`)
        if (remote)
          json(res, { now: Date.now(), node: remote.node })
        else
          send(res, 404, 'Node not found')
        return
      }

      const runMatch = /^\/api\/runs\/([^/]+)$/.exec(path)
      if (runMatch) {
        const run = store.getRun(decodeURIComponent(runMatch[1]!))
        if (run) {
          json(res, { now: Date.now(), run: liteRun(run) })
          return
        }
        const remote = local ? undefined : await fromPeers<{ run: FlowRun }>(`${path}?local=1`)
        if (remote)
          json(res, { now: Date.now(), run: remote.run })
        else
          send(res, 404, 'Run not found')
        return
      }

      const file = path === '/' ? 'index.html' : normalize(path.slice(1))
      if (!STATIC.has(file)) {
        send(res, 404, 'Not found')
        return
      }
      const body = await readFile(join(uiDir, file), 'utf8')
      send(res, 200, body, MIME[extname(file)] ?? 'application/octet-stream')
    }
    catch (error) {
      if (!res.headersSent)
        send(res, 500, error instanceof Error ? error.message : 'Internal error')
      else
        res.end()
    }
  })

  try {
    port = await listen(server, options.port, host)
  }
  catch (error) {
    // Another process (the desktop app next to the daemon) has the port: take
    // any free one. Peers make either address show everything.
    if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || options.port === 0)
      throw error
    port = await listen(server, 0, host)
  }

  return {
    port,
    url: `http://127.0.0.1:${port}/`,
    onRemoteChange(listener) {
      remoteListeners.add(listener)
      syncUpstreams()
      return () => {
        remoteListeners.delete(listener)
        syncUpstreams()
      }
    },
    async remoteLatestRun(sessionId) {
      if (!options.peers)
        return undefined
      const latest = (await peerRuns()).runs
        .filter(r => !sessionId || r.sessionId === sessionId)
        .sort((a, b) => b.startedAt - a.startedAt)[0]
      if (!latest)
        return undefined
      return (await fromPeers<{ run: FlowRun }>(`/api/runs/${encodeURIComponent(latest.id)}?local=1`))?.run
    },
    close: () => new Promise<void>((resolve) => {
      unsubscribe()
      clearInterval(heartbeat)
      if (appearanceTimer)
        clearInterval(appearanceTimer)
      if (peerTimer)
        clearInterval(peerTimer)
      for (const controller of upstreams.values())
        controller.abort()
      upstreams.clear()
      remoteListeners.clear()
      if (timer)
        clearTimeout(timer)
      for (const client of clients)
        client.res.end()
      clients.clear()
      server.close(() => resolve())
      server.closeAllConnections?.()
    }),
  }
}
