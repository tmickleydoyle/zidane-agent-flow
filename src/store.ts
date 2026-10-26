/**
 * In-memory model of how the agent works: Session → Run → Turn → Tool call
 * → Subagent → its turns and tools. Fed by `src/hooks.ts`, read by the web
 * UI (`src/server.ts`) and the side panel (`src/panel.ts`).
 *
 * Pure data, no zidane imports at runtime: the same module runs in the TUI
 * (Bun), the desktop main process (Node through jiti) and the tests.
 */

export type NodeKind = 'run' | 'turn' | 'tool' | 'agent'
export type NodeStatus = 'queued' | 'running' | 'success' | 'error' | 'cancelled'

export interface NodeData {
  tool?: string
  input?: string
  output?: string
  error?: string
  text?: string
  thinking?: string
  task?: string
  childId?: string
  model?: string
  provider?: string
  finishReason?: string
  tokensIn?: number
  tokensOut?: number
  cacheRead?: number
  cost?: number
  outputBytes?: number
  turn?: number
  /** Turn only: model streaming time, and whether the model is done (its tools may still run). */
  llmMs?: number
  streamDone?: boolean
}

export interface FlowNode {
  id: string
  kind: NodeKind
  label: string
  detail?: string
  status: NodeStatus
  startedAt: number
  endedAt?: number
  /** Agent depth: 0 for the root agent, 1 for its subagents, … */
  depth: number
  children: FlowNode[]
  data: NodeData
}

export interface RunStats {
  turns: number
  tools: number
  agents: number
  errors: number
  tokensIn: number
  tokensOut: number
  cost: number
}

export interface FlowRun {
  /** `<sessionId>/<runId>`: zidane run ids are per-agent counters (`run_1`). */
  id: string
  runId: string
  sessionId: string
  prompt: string
  status: NodeStatus
  startedAt: number
  endedAt?: number
  version: number
  /** True when the node cap was hit and later events were dropped. */
  truncated?: boolean
  /** When the run last reported anything. */
  lastEventAt?: number
  /**
   * `inferred`: zidane never sent this run's end (it does not when a run's
   * setup fails, e.g. a sandbox that cannot start); the visualizer closed it
   * because the conversation moved on. Any later event reopens it.
   */
  endedBy?: 'event' | 'inferred'
  root: FlowNode
}

/** What a run is doing right now: its most recently started open step. */
export interface RunActivity {
  id: string
  kind: NodeKind
  label: string
  detail?: string
  startedAt: number
  depth: number
  data: Pick<NodeData, 'tool' | 'turn' | 'childId'>
}

export interface RunSummary {
  id: string
  sessionId: string
  prompt: string
  status: NodeStatus
  startedAt: number
  endedAt?: number
  version: number
  lastEventAt?: number
  endedBy?: 'event' | 'inferred'
  stats: RunStats
  /** Open runs only. */
  activity?: RunActivity
  /** Subagents still working. */
  helpersRunning: number
}

export interface StoreLimits {
  maxRuns: number
  maxNodesPerRun: number
  maxTextChars: number
}

export const DEFAULT_LIMITS: StoreLimits = { maxRuns: 60, maxNodesPerRun: 3000, maxTextChars: 8000 }

/** Session id used when a run has no bound session (bare SDK hosts). */
export const LOCAL_SESSION = 'local'

interface RunIndex {
  run: FlowRun
  nodes: Map<string, FlowNode>
  parents: Map<string, FlowNode>
}

/** Agent key: `root`, or the call id of the `spawn` call that started the subagent. */
export const ROOT = 'root'

export function runKey(sessionId: string, runId: string): string {
  return `${sessionId}/${runId}`
}

type Listener = (runId: string) => void

export function truncate(text: string, max: number): string {
  return text.length > max ? `${text.slice(0, max)}\n… (${text.length - max} more chars)` : text
}

/** Tool results are a string or content blocks; keep the text parts. */
export function resultText(result: unknown): string {
  if (typeof result === 'string')
    return result
  if (Array.isArray(result)) {
    return result
      .map((block) => {
        if (block && typeof block === 'object') {
          const b = block as { type?: string, text?: unknown }
          if (typeof b.text === 'string')
            return b.text
          return `[${b.type ?? 'block'}]`
        }
        return String(block)
      })
      .join('\n')
  }
  return result === undefined ? '' : safeJson(result)
}

export function safeJson(value: unknown): string {
  try {
    return JSON.stringify(value, null, 2) ?? ''
  }
  catch {
    return String(value)
  }
}

const SUMMARY_KEYS = ['command', 'description', 'path', 'pattern', 'query', 'url', 'task', 'prompt', 'title', 'name', 'id', 'key']

/** One short line saying what a tool call is about: its command, path, query… */
export function summarizeInput(input: Record<string, unknown> | undefined): string | undefined {
  if (!input || typeof input !== 'object')
    return undefined
  for (const key of SUMMARY_KEYS) {
    const value = input[key]
    if (typeof value === 'string' && value.trim())
      return oneLine(value)
  }
  if (Array.isArray(input.paths) && input.paths.length > 0)
    return `${input.paths.length} paths`
  for (const value of Object.values(input)) {
    if (typeof value === 'string' && value.trim())
      return oneLine(value)
  }
  return undefined
}

export function oneLine(text: string, max = 140): string {
  const line = text.replace(/\s+/g, ' ').trim()
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

function isOpen(status: NodeStatus): boolean {
  return status === 'running' || status === 'queued'
}

export function computeStats(run: FlowRun): RunStats {
  const stats: RunStats = { turns: 0, tools: 0, agents: 0, errors: 0, tokensIn: 0, tokensOut: 0, cost: 0 }
  const walk = (node: FlowNode): void => {
    if (node.kind === 'turn') {
      stats.turns++
      stats.tokensIn += node.data.tokensIn ?? 0
      stats.tokensOut += node.data.tokensOut ?? 0
      stats.cost += node.data.cost ?? 0
    }
    else if (node.kind === 'tool') {
      stats.tools++
    }
    else if (node.kind === 'agent') {
      stats.agents++
    }
    if (node.status === 'error')
      stats.errors++
    for (const child of node.children)
      walk(child)
  }
  walk(run.root)
  return stats
}

/** The open step started last (deepest wins ties), and how many subagents are open. */
export function currentActivity(run: FlowRun): { activity?: RunActivity, helpersRunning: number } {
  let best: FlowNode | undefined
  let helpersRunning = 0
  const walk = (node: FlowNode): void => {
    for (const child of node.children) {
      if (!isOpen(child.status))
        continue
      if (child.kind === 'agent')
        helpersRunning++
      if (!best || child.startedAt >= best.startedAt)
        best = child
      walk(child)
    }
  }
  if (isOpen(run.status))
    walk(run.root)
  const activity = best && {
    id: best.id,
    kind: best.kind,
    label: best.label,
    ...(best.detail ? { detail: best.detail } : {}),
    startedAt: best.startedAt,
    depth: best.depth,
    data: {
      ...(best.data.tool ? { tool: best.data.tool } : {}),
      ...(best.data.turn !== undefined ? { turn: best.data.turn } : {}),
      ...(best.data.childId ? { childId: best.data.childId } : {}),
    },
  }
  return { ...(activity ? { activity } : {}), helpersRunning }
}

export function summarize(run: FlowRun): RunSummary {
  return {
    ...currentActivity(run),
    id: run.id,
    sessionId: run.sessionId,
    prompt: run.prompt,
    status: run.status,
    startedAt: run.startedAt,
    ...(run.endedAt !== undefined ? { endedAt: run.endedAt } : {}),
    version: run.version,
    ...(run.lastEventAt !== undefined ? { lastEventAt: run.lastEventAt } : {}),
    ...(run.endedBy ? { endedBy: run.endedBy } : {}),
    stats: computeStats(run),
  }
}

/**
 * The tree store. Node ids inside a run:
 *   turn  `u:<turnId>`   (turn ids are UUIDs)
 *   tool  `t:<callId>`
 *   agent `a:<spawnCallId>` (child ids repeat: every agent's first child is `child-1`)
 */
export class FlowStore {
  private readonly runs = new Map<string, RunIndex>()
  /** Most recent root run per session. */
  private readonly currentBySession = new Map<string, string>()
  private readonly listeners = new Set<Listener>()
  /** Summaries by run, valid while the run's version is unchanged. */
  private readonly summaries = new Map<string, RunSummary>()
  readonly limits: StoreLimits

  constructor(limits: Partial<StoreLimits> = {}, private readonly now: () => number = Date.now) {
    this.limits = { ...DEFAULT_LIMITS, ...limits }
  }

  // ---------------------------------------------------------------------
  // Reads
  // ---------------------------------------------------------------------

  /** Newest first. Summaries are cached per run version: many sessions streaming at once only re-walk the runs that changed. */
  listRuns(): RunSummary[] {
    const out: RunSummary[] = []
    for (const { run } of this.runs.values()) {
      let summary = this.summaries.get(run.id)
      if (!summary || summary.version !== run.version) {
        summary = summarize(run)
        this.summaries.set(run.id, summary)
      }
      out.push(summary)
    }
    return out.sort((a, b) => b.startedAt - a.startedAt)
  }

  getRun(runId: string): FlowRun | undefined {
    return this.runs.get(runId)?.run
  }

  /** The newest run of a session, or the newest run overall without one. */
  latestRun(sessionId?: string): FlowRun | undefined {
    let best: FlowRun | undefined
    for (const { run } of this.runs.values()) {
      if (sessionId && run.sessionId !== sessionId)
        continue
      if (!best || run.startedAt > best.startedAt)
        best = run
    }
    return best
  }

  getNode(runId: string, nodeId: string): FlowNode | undefined {
    return this.runs.get(runId)?.nodes.get(nodeId)
  }

  currentRunId(sessionId: string): string | undefined {
    return this.currentBySession.get(sessionId)
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  // ---------------------------------------------------------------------
  // Runs
  // ---------------------------------------------------------------------

  startRun(input: { runId: string, sessionId?: string, prompt?: string, startedAt?: number }): FlowRun {
    const sessionId = input.sessionId ?? LOCAL_SESSION
    const id = runKey(sessionId, input.runId)
    const existing = this.runs.get(id)
    if (existing) {
      this.revive(existing.run)
      if (input.prompt && !existing.run.prompt) {
        existing.run.prompt = input.prompt
        existing.run.root.label = oneLine(input.prompt) || existing.run.root.label
        this.touch(existing.run)
      }
      return existing.run
    }
    const startedAt = input.startedAt ?? this.now()
    const prompt = input.prompt ?? ''
    const root: FlowNode = {
      id: `run:${id}`,
      kind: 'run',
      label: oneLine(prompt) || 'Run',
      status: 'running',
      startedAt,
      depth: 0,
      children: [],
      data: {},
    }
    // A conversation runs one request at a time: an earlier one still open
    // here never got its end event.
    this.closeSession(sessionId, 'A newer request started in this conversation before this one reported finishing.')
    const run: FlowRun = { id, runId: input.runId, sessionId, prompt, status: 'running', startedAt, version: 0, root }
    this.runs.set(run.id, { run, nodes: new Map([[root.id, root]]), parents: new Map() })
    this.currentBySession.set(sessionId, run.id)
    this.evict()
    this.touch(run)
    return run
  }

  endRun(runId: string, status: 'completed' | 'aborted' | 'error' | NodeStatus, extra: { error?: string, cost?: number, tokensIn?: number, tokensOut?: number, inferred?: boolean } = {}): void {
    const index = this.runs.get(runId)
    if (!index)
      return
    const { run } = index
    if (extra.inferred && !isOpen(run.status))
      return
    run.endedBy = extra.inferred ? 'inferred' : 'event'
    const final: NodeStatus = status === 'completed' ? 'success' : status === 'aborted' ? 'cancelled' : status
    const at = this.now()
    run.status = final
    run.endedAt ??= at
    run.root.status = final
    run.root.endedAt ??= at
    if (extra.error)
      run.root.data.error = extra.error
    if (extra.cost !== undefined)
      run.root.data.cost = extra.cost
    if (extra.tokensIn !== undefined)
      run.root.data.tokensIn = extra.tokensIn
    if (extra.tokensOut !== undefined)
      run.root.data.tokensOut = extra.tokensOut
    // Anything still open did not finish with the run.
    for (const node of index.nodes.values()) {
      if (isOpen(node.status)) {
        node.status = final === 'success' ? 'success' : 'cancelled'
        node.endedAt ??= at
      }
    }
    this.touch(run)
  }

  // ---------------------------------------------------------------------
  // Turns
  // ---------------------------------------------------------------------

  turnStart(runId: string, agent: string, turnId: string, turn?: number): FlowNode | undefined {
    this.reviveById(runId)
    return this.ensureTurn(runId, agent, turnId, turn)
  }

  turnText(runId: string, agent: string, turnId: string, field: 'text' | 'thinking', value: string): void {
    this.reviveById(runId)
    const node = this.ensureTurn(runId, agent, turnId)
    if (!node)
      return
    node.data[field] = truncate(value, this.limits.maxTextChars)
    if (field === 'text' && value.trim())
      node.detail = oneLine(value)
    this.touch(this.runs.get(runId)!.run)
  }

  turnEnd(runId: string, agent: string, turnId: string, info: { turn?: number, aborted?: boolean, usage?: { input?: number, output?: number, cacheRead?: number, cost?: number, modelId?: string, finishReason?: string } }): void {
    const node = this.ensureTurn(runId, agent, turnId, info.turn)
    if (!node)
      return
    const usage = info.usage ?? {}
    const at = this.now()
    node.data.streamDone = true
    node.data.llmMs = at - node.startedAt
    if (info.aborted) {
      node.status = 'cancelled'
      node.endedAt = at
    }
    else if (node.status === 'running' && !node.children.some(c => isOpen(c.status))) {
      node.status = 'success'
      node.endedAt = at
    }
    if (usage.input !== undefined)
      node.data.tokensIn = usage.input
    if (usage.output !== undefined)
      node.data.tokensOut = usage.output
    if (usage.cacheRead !== undefined)
      node.data.cacheRead = usage.cacheRead
    if (usage.cost !== undefined)
      node.data.cost = usage.cost
    if (usage.modelId)
      node.data.model = usage.modelId
    if (usage.finishReason)
      node.data.finishReason = usage.finishReason
    this.touch(this.runs.get(runId)!.run)
  }

  turnError(runId: string, agent: string, turnId: string, error: string): void {
    const node = this.ensureTurn(runId, agent, turnId)
    if (!node)
      return
    node.status = 'error'
    node.endedAt = this.now()
    node.data.error = truncate(error, this.limits.maxTextChars)
    this.touch(this.runs.get(runId)!.run)
  }

  // ---------------------------------------------------------------------
  // Tools
  // ---------------------------------------------------------------------

  toolStart(runId: string, agent: string, input: { turnId: string, callId: string, name: string, displayName?: string, input?: Record<string, unknown>, parentToolCallId?: string }): FlowNode | undefined {
    const index = this.runs.get(runId)
    if (!index)
      return undefined
    this.revive(index.run)
    const key = `t:${input.callId}`
    const existing = index.nodes.get(key)
    if (existing)
      return existing
    // A subagent turn first seen through its text was placed by child id; the
    // tool's spawn call id is exact, so move the turn if it landed elsewhere.
    const agentNode = agent === ROOT ? index.run.root : index.nodes.get(`a:${agent}`)
    const known = index.nodes.get(`u:${input.turnId}`)
    if (known && agentNode && index.parents.get(known.id) !== agentNode)
      this.move(index, known, agentNode)
    const parent = (input.parentToolCallId ? index.nodes.get(`t:${input.parentToolCallId}`) : undefined)
      ?? this.ensureTurn(runId, agent, input.turnId)
    if (!parent)
      return undefined
    this.reopen(index, parent)
    const node = this.add(index, parent, {
      id: key,
      kind: 'tool',
      label: input.displayName || input.name,
      detail: summarizeInput(input.input),
      status: 'running',
      startedAt: this.now(),
      depth: parent.depth,
      children: [],
      data: {
        tool: input.name,
        ...(input.input ? { input: truncate(safeJson(input.input), this.limits.maxTextChars) } : {}),
      },
    })
    if (node) {
      this.updateTurnDetail(index, node)
      this.touch(index.run)
    }
    return node
  }

  toolEnd(runId: string, agent: string, callId: string, info: { result?: unknown, isError?: boolean, error?: string, cancelled?: string, outputBytes?: number }): void {
    const index = this.runs.get(runId)
    const node = index?.nodes.get(`t:${callId}`)
    if (!index || !node)
      return
    node.endedAt = this.now()
    if (info.cancelled !== undefined) {
      node.status = 'cancelled'
      node.data.error = info.cancelled
    }
    else if (info.error !== undefined || info.isError) {
      node.status = 'error'
      node.data.error = truncate(info.error ?? resultText(info.result), this.limits.maxTextChars)
    }
    else {
      node.status = 'success'
    }
    if (info.result !== undefined)
      node.data.output = truncate(resultText(info.result), this.limits.maxTextChars)
    if (info.outputBytes !== undefined)
      node.data.outputBytes = info.outputBytes
    this.settleUp(index, node)
    this.touch(index.run)
  }

  // ---------------------------------------------------------------------
  // Subagents
  // ---------------------------------------------------------------------

  /** A subagent starts; `callId` is the `spawn` call that started it, and becomes its agent key. */
  agentStart(runId: string, input: { childId: string, task: string, callId?: string, depth?: number, model?: string, provider?: string }): FlowNode | undefined {
    const index = this.runs.get(runId)
    if (!index)
      return undefined
    this.revive(index.run)
    const key = `a:${input.callId ?? input.childId}`
    const existing = index.nodes.get(key)
    if (existing)
      return existing
    const parent = (input.callId ? index.nodes.get(`t:${input.callId}`) : undefined) ?? index.run.root
    const node = this.add(index, parent, {
      id: key,
      kind: 'agent',
      label: input.childId,
      detail: oneLine(input.task),
      status: 'running',
      startedAt: this.now(),
      depth: input.depth ?? parent.depth + 1,
      children: [],
      data: {
        task: truncate(input.task, this.limits.maxTextChars),
        childId: input.childId,
        ...(input.model ? { model: input.model } : {}),
        ...(input.provider ? { provider: input.provider } : {}),
      },
    })
    if (node)
      this.touch(index.run)
    return node
  }

  agentEnd(runId: string, agent: string, info: { status?: string, error?: string, cost?: number, tokensIn?: number, tokensOut?: number, output?: unknown }): void {
    const index = this.runs.get(runId)
    const node = index?.nodes.get(`a:${agent}`)
    if (!index || !node)
      return
    node.endedAt = this.now()
    if (info.error !== undefined) {
      node.status = 'error'
      node.data.error = truncate(info.error, this.limits.maxTextChars)
    }
    else if (info.status === 'aborted') {
      node.status = 'cancelled'
    }
    else if (info.status === 'error' || info.status === 'timeout') {
      node.status = 'error'
      node.data.error ??= info.status
    }
    else if (node.status !== 'error') {
      node.status = 'success'
    }
    if (info.cost !== undefined)
      node.data.cost = info.cost
    if (info.tokensIn !== undefined)
      node.data.tokensIn = info.tokensIn
    if (info.tokensOut !== undefined)
      node.data.tokensOut = info.tokensOut
    if (info.output !== undefined)
      node.data.output = truncate(resultText(info.output), this.limits.maxTextChars)
    // Close the subagent's own open nodes.
    const close = (n: FlowNode): void => {
      for (const c of n.children) {
        if (isOpen(c.status)) {
          c.status = node.status === 'success' ? 'success' : 'cancelled'
          c.endedAt ??= node.endedAt
        }
        if (c.kind !== 'agent')
          close(c)
      }
    }
    close(node)
    this.settleUp(index, node)
    this.touch(index.run)
  }

  /**
   * The agent key of subagent `childId` at `depth`, for events that carry no
   * spawn call id (text, turn ends). Prefers a running one, newest first.
   */
  findAgent(runId: string, childId: string, depth: number): string | undefined {
    const index = this.runs.get(runId)
    if (!index)
      return undefined
    let best: FlowNode | undefined
    for (const node of index.nodes.values()) {
      if (node.kind !== 'agent' || node.data.childId !== childId || node.depth !== depth)
        continue
      const better = !best
        || (isOpen(node.status) && !isOpen(best.status))
        || (isOpen(node.status) === isOpen(best.status) && node.startedAt >= best.startedAt)
      if (better)
        best = node
    }
    return best ? best.id.slice(2) : undefined
  }

  /** The agent key owning turn `turnId`, when the turn is known. */
  turnAgent(runId: string, turnId: string): string | undefined {
    const index = this.runs.get(runId)
    const turn = index?.nodes.get(`u:${turnId}`)
    const parent = turn && index!.parents.get(turn.id)
    if (!parent)
      return undefined
    return parent.kind === 'run' ? ROOT : parent.id.slice(2)
  }

  /**
   * Close every open run of a session as never-finished (`inferred`): the
   * host said the conversation is idle, or a newer request started in it.
   * Returns how many were closed.
   */
  closeSession(sessionId: string, reason = 'zidane finished this conversation’s request without reporting how it ended.'): number {
    let closed = 0
    for (const { run } of this.runs.values()) {
      if (run.sessionId !== sessionId || !isOpen(run.status))
        continue
      this.endRun(run.id, 'cancelled', { inferred: true, error: reason })
      closed++
    }
    return closed
  }

  /**
   * The only open run, for events that cannot name their session. With
   * several runs open (many sessions at once) a guess could land in the
   * wrong one, so there is no answer.
   */
  soleOpenRun(): string | undefined {
    let found: string | undefined
    for (const { run } of this.runs.values()) {
      if (!isOpen(run.status))
        continue
      if (found)
        return undefined
      found = run.id
    }
    return found
  }

  openRunCount(): number {
    let n = 0
    for (const { run } of this.runs.values()) {
      if (isOpen(run.status))
        n++
    }
    return n
  }

  // ---------------------------------------------------------------------
  // Persistence
  // ---------------------------------------------------------------------

  serialize(): { version: 1, runs: FlowRun[] } {
    return { version: 1, runs: [...this.runs.values()].map(i => i.run) }
  }

  /** Load persisted runs; runs that were open when saved are marked interrupted. */
  hydrate(data: unknown): number {
    if (!data || typeof data !== 'object' || (data as { version?: unknown }).version !== 1)
      return 0
    const runs = (data as { runs?: unknown }).runs
    if (!Array.isArray(runs))
      return 0
    let loaded = 0
    for (const raw of runs) {
      const run = raw as FlowRun
      if (!run || typeof run.id !== 'string' || !run.root || this.runs.has(run.id))
        continue
      const nodes = new Map<string, FlowNode>()
      const parents = new Map<string, FlowNode>()
      const walk = (node: FlowNode): void => {
        nodes.set(node.id, node)
        for (const child of node.children ?? [])
          parents.set(child.id, node)
        if (isOpen(node.status)) {
          node.status = 'cancelled'
          node.endedAt ??= run.endedAt ?? node.startedAt
          node.data.error ??= 'Interrupted (extension reloaded)'
        }
        for (const child of node.children ?? [])
          walk(child)
      }
      walk(run.root)
      if (isOpen(run.status)) {
        run.status = 'cancelled'
        run.endedAt ??= run.root.endedAt
      }
      run.runId ??= run.id
      this.runs.set(run.id, { run, nodes, parents })
      if (!this.currentBySession.has(run.sessionId) || (this.latestRun(run.sessionId)?.id === run.id))
        this.currentBySession.set(run.sessionId, run.id)
      loaded++
    }
    this.evict()
    return loaded
  }

  // ---------------------------------------------------------------------
  // Internals
  // ---------------------------------------------------------------------

  private ensureTurn(runId: string, agent: string, turnId: string, turn?: number): FlowNode | undefined {
    const index = this.runs.get(runId)
    if (!index)
      return undefined
    const key = `u:${turnId}`
    const existing = index.nodes.get(key)
    if (existing) {
      if (turn !== undefined && existing.data.turn === undefined) {
        existing.data.turn = turn
        existing.label = `Turn ${turn + 1}`
      }
      return existing
    }
    const parent = agent === ROOT ? index.run.root : index.nodes.get(`a:${agent}`)
    if (!parent)
      return undefined
    const ordinal = turn ?? parent.children.filter(c => c.kind === 'turn').length
    const node = this.add(index, parent, {
      id: key,
      kind: 'turn',
      label: `Turn ${ordinal + 1}`,
      status: 'running',
      startedAt: this.now(),
      depth: agent === ROOT ? 0 : parent.depth,
      children: [],
      data: { turn: ordinal },
    })
    if (node)
      this.touch(index.run)
    return node
  }

  private add(index: RunIndex, parent: FlowNode, node: FlowNode): FlowNode | undefined {
    if (index.nodes.size >= this.limits.maxNodesPerRun) {
      index.run.truncated = true
      return undefined
    }
    parent.children.push(node)
    index.nodes.set(node.id, node)
    index.parents.set(node.id, parent)
    return node
  }

  private reviveById(runId: string): void {
    const run = this.runs.get(runId)?.run
    if (run)
      this.revive(run)
  }

  /** A run closed by inference that reports again was not over: open it again. */
  private revive(run: FlowRun): void {
    if (run.endedBy !== 'inferred')
      return
    run.status = 'running'
    run.endedAt = undefined
    run.endedBy = undefined
    run.root.status = 'running'
    run.root.endedAt = undefined
    delete run.root.data.error
  }

  private move(index: RunIndex, node: FlowNode, to: FlowNode): void {
    const from = index.parents.get(node.id)
    if (from)
      from.children = from.children.filter(c => c !== node)
    to.children.push(node)
    to.children.sort((a, b) => a.startedAt - b.startedAt)
    index.parents.set(node.id, to)
    node.depth = to.kind === 'run' ? 0 : to.depth
  }

  /** A turn whose model output ended is open again while its tools run. */
  private reopen(index: RunIndex, node: FlowNode): void {
    if (node.kind === 'turn' && node.status === 'success') {
      node.status = 'running'
      node.endedAt = undefined
    }
  }

  /** Close turns whose model output ended once their last tool finishes. */
  private settleUp(index: RunIndex, node: FlowNode): void {
    let parent = index.parents.get(node.id)
    while (parent) {
      if (parent.kind === 'turn' && parent.status === 'running' && parent.data.streamDone && !parent.children.some(c => isOpen(c.status))) {
        parent.status = 'success'
        parent.endedAt = Math.max(parent.startedAt + (parent.data.llmMs ?? 0), ...parent.children.map(c => c.endedAt ?? 0))
      }
      parent = index.parents.get(parent.id)
    }
  }

  private updateTurnDetail(index: RunIndex, tool: FlowNode): void {
    const turn = index.parents.get(tool.id)
    if (turn?.kind !== 'turn' || turn.data.text?.trim())
      return
    const names = [...new Set(turn.children.filter(c => c.kind === 'tool').map(c => c.label))]
    turn.detail = `→ ${names.join(', ')}`
  }

  private evict(): void {
    if (this.runs.size <= this.limits.maxRuns)
      return
    const oldest = [...this.runs.values()]
      .map(i => i.run)
      .filter(r => !isOpen(r.status))
      .sort((a, b) => a.startedAt - b.startedAt)
    for (const run of oldest) {
      if (this.runs.size <= this.limits.maxRuns)
        break
      this.runs.delete(run.id)
      this.summaries.delete(run.id)
      if (this.currentBySession.get(run.sessionId) === run.id)
        this.currentBySession.delete(run.sessionId)
    }
  }

  private touch(run: FlowRun): void {
    run.version++
    run.lastEventAt = this.now()
    for (const listener of this.listeners) {
      try {
        listener(run.id)
      }
      catch {
        // A broken listener must never break the agent run.
      }
    }
  }
}
