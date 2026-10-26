import type { AgentHooks, ExtensionContext } from 'zidane'
import type { FlowStore } from './store'
import { LOCAL_SESSION, resultText, ROOT, runKey } from './store'

/** Per-session key (in this extension's `ctx.session` bag) holding the session id. */
const SESSION_ID_KEY = 'sessionId'

type HookSurface = Pick<ExtensionContext, 'registerHook' | 'session' | 'logger'>

interface ChildRef {
  childId: string
  depth: number
}

function errorText(error: unknown): string {
  if (error instanceof Error)
    return error.message
  return typeof error === 'string' ? error : resultText(error)
}

/**
 * Feed the store from the agent's hook bus.
 *
 * Attribution: `session:start` carries `{ sessionId, runId }` and stores the
 * session id in this extension's session bag. Every later hook, subagent
 * (`child:*`) ones included, runs inside the run's async context, where
 * `ctx.session` reads that bag, so each event finds its session's current
 * run. Inside a run, subagents are keyed by the `spawn` call that started
 * them: child tool events name it (`parentCallId`); text and turn events
 * only carry `{ childId, depth }` and resolve through the turn or child id.
 */
export function registerFlowHooks(ctx: HookSurface, store: FlowStore): void {
  const on = <E extends keyof AgentHooks>(event: E, handler: (payload: Parameters<AgentHooks[E]>[0]) => void): void => {
    const safe = ((payload: Parameters<AgentHooks[E]>[0]) => {
      try {
        handler(payload)
      }
      catch (error) {
        ctx.logger.debug?.(`agent-flow: ${event} handler failed`, { error: errorText(error) })
      }
    }) as unknown as AgentHooks[E]
    ctx.registerHook(event, safe)
  }

  const sessionId = (): string | undefined => {
    try {
      const value = ctx.session.get<string>(SESSION_ID_KEY)
      return typeof value === 'string' ? value : undefined
    }
    catch {
      return undefined
    }
  }

  /**
   * The current root run of the hook's session (`rawRunId`: the root
   * agent's own run id). Without a session id (bare SDK hosts) it only
   * answers when one run is open: with many running at once, a guess
   * would put the event in another session's tree.
   */
  const runFor = (rawRunId?: string): string | undefined => {
    const sid = sessionId()
    if (rawRunId) {
      const key = runKey(sid ?? LOCAL_SESSION, rawRunId)
      if (store.getRun(key))
        return key
    }
    return sid ? store.currentRunId(sid) : store.soleOpenRun()
  }

  /** Run and agent key of a subagent event without a spawn call id. */
  const childTarget = (ref: ChildRef & { turnId?: string }): { run: string, agent: string } | undefined => {
    const run = runFor()
    if (!run)
      return undefined
    const agent = (ref.turnId ? store.turnAgent(run, ref.turnId) : undefined) ?? store.findAgent(run, ref.childId, ref.depth)
    return agent ? { run, agent } : undefined
  }

  /** Run and agent key of a subagent tool event: `parentCallId` is its spawn call. */
  const childToolTarget = (ref: ChildRef & { parentCallId?: string }): { run: string, agent: string } | undefined => {
    if (!ref.parentCallId)
      return childTarget(ref)
    const run = runFor()
    return run ? { run, agent: ref.parentCallId } : undefined
  }

  // ---------------------------------------------------------------- runs

  on('session:start', ({ sessionId: sid, runId, prompt }) => {
    store.startRun({ runId, sessionId: sid, prompt })
    if (sessionId() !== sid)
      ctx.session.set(SESSION_ID_KEY, sid).catch(() => {})
  })

  on('agent:start', ({ runId, depth, startedAt }) => {
    const sid = sessionId() ?? LOCAL_SESSION
    if (depth === 0 && !store.getRun(runKey(sid, runId)))
      store.startRun({ runId, sessionId: sid, startedAt })
  })

  on('session:end', ({ sessionId: sid, runId, status }) => {
    store.endRun(runKey(sid, runId), status)
  })

  on('agent:abort', ({ runId }) => {
    const run = runFor(runId)
    if (run)
      store.endRun(run, 'aborted')
  })

  on('agent:done', (stats) => {
    const run = runFor()
    if (!run)
      return
    const current = store.getRun(run)
    // Hosts without a session never fire `session:end`.
    store.endRun(run, current?.status === 'running' ? 'completed' : (current?.status ?? 'completed'), {
      ...(stats.cost !== undefined ? { cost: stats.cost } : {}),
      tokensIn: stats.totalIn,
      tokensOut: stats.totalOut,
    })
  })

  // --------------------------------------------------------- root turns

  on('turn:before', ({ turn, turnId }) => {
    const run = runFor()
    if (run)
      store.turnStart(run, ROOT, turnId, turn)
  })

  on('stream:text', ({ turnId, text }) => {
    const run = runFor()
    if (run)
      store.turnText(run, ROOT, turnId, 'text', text)
  })

  on('stream:thinking', ({ turnId, thinking }) => {
    const run = runFor()
    if (run)
      store.turnText(run, ROOT, turnId, 'thinking', thinking)
  })

  on('stream:error', ({ turnId, err }) => {
    const run = runFor()
    if (run)
      store.turnError(run, ROOT, turnId, errorText(err))
  })

  on('turn:after', ({ turn, turnId, usage, aborted }) => {
    const run = runFor()
    if (run)
      store.turnEnd(run, ROOT, turnId, { turn, ...(aborted !== undefined ? { aborted } : {}), usage })
  })

  // --------------------------------------------------------- root tools

  on('tool:before', (e) => {
    const run = runFor(e.runId)
    if (run)
      store.toolStart(run, ROOT, { ...e, ...(e.parentToolCallId ? { parentToolCallId: e.parentToolCallId } : {}) })
  })

  on('tool:after', (e) => {
    const run = runFor(e.runId)
    if (run)
      store.toolEnd(run, ROOT, e.callId, { result: e.result, isError: e.isError, outputBytes: e.outputBytes })
  })

  on('tool:error', (e) => {
    const run = runFor(e.runId)
    if (run)
      store.toolEnd(run, ROOT, e.callId, { error: errorText(e.error), ...(e.result !== undefined ? { result: e.result } : {}) })
  })

  on('tool:cancelled', (e) => {
    const run = runFor(e.runId)
    if (run)
      store.toolEnd(run, ROOT, e.callId, { cancelled: e.reason })
  })

  // --------------------------------------------------------- subagents

  const startAgent = (e: { id: string, task: string, callId?: string, depth?: number, model?: string, provider?: string }): void => {
    const run = runFor()
    if (!run)
      return
    store.agentStart(run, {
      childId: e.id,
      task: e.task,
      ...(e.callId ? { callId: e.callId } : {}),
      ...(e.depth !== undefined ? { depth: e.depth } : {}),
      ...(e.model ? { model: e.model } : {}),
      ...(e.provider ? { provider: e.provider } : {}),
    })
  }

  const endAgent = (e: { id: string, callId?: string, depth?: number, status?: string, stats?: { cost?: number, totalIn: number, totalOut: number }, output?: unknown }, error?: unknown): void => {
    const run = runFor()
    if (!run)
      return
    const agent = e.callId ?? store.findAgent(run, e.id, e.depth ?? 1)
    if (!agent)
      return
    store.agentEnd(run, agent, error !== undefined
      ? { error: errorText(error) }
      : {
          ...(e.status ? { status: e.status } : {}),
          ...(e.stats?.cost !== undefined ? { cost: e.stats.cost } : {}),
          ...(e.stats ? { tokensIn: e.stats.totalIn, tokensOut: e.stats.totalOut } : {}),
          ...(e.output !== undefined ? { output: e.output } : {}),
        })
  }

  on('spawn:before', startAgent)
  on('child:spawn:before', startAgent)
  on('spawn:complete', e => endAgent(e))
  on('child:spawn:complete', e => endAgent(e))
  on('spawn:error', e => endAgent(e, e.error))
  on('child:spawn:error', e => endAgent(e, e.error))

  // ------------------------------------------------- subagent turns/tools

  on('child:stream:text', (e) => {
    const t = childTarget(e)
    if (t)
      store.turnText(t.run, t.agent, e.turnId, 'text', e.text)
  })

  on('child:stream:thinking', (e) => {
    const t = childTarget(e)
    if (t)
      store.turnText(t.run, t.agent, e.turnId, 'thinking', e.thinking)
  })

  on('child:stream:error', (e) => {
    const t = childTarget(e)
    if (t)
      store.turnError(t.run, t.agent, e.turnId, errorText(e.err))
  })

  on('child:turn:after', (e) => {
    const t = childTarget(e)
    if (t)
      store.turnEnd(t.run, t.agent, e.turnId, { turn: e.turn, ...(e.aborted !== undefined ? { aborted: e.aborted } : {}), usage: e.usage })
  })

  on('child:tool:before', (e) => {
    const t = childToolTarget(e)
    if (t)
      store.toolStart(t.run, t.agent, { ...e, ...(e.parentToolCallId ? { parentToolCallId: e.parentToolCallId } : {}) })
  })

  on('child:tool:after', (e) => {
    const t = childToolTarget(e)
    if (t)
      store.toolEnd(t.run, t.agent, e.callId, { result: e.result, ...(e.isError !== undefined ? { isError: e.isError } : {}), outputBytes: e.outputBytes })
  })

  on('child:tool:error', (e) => {
    const t = childToolTarget(e)
    if (t)
      store.toolEnd(t.run, t.agent, e.callId, { error: errorText(e.error) })
  })

  on('child:tool:cancelled', (e) => {
    const t = childToolTarget(e)
    if (t)
      store.toolEnd(t.run, t.agent, e.callId, { cancelled: e.reason })
  })
}
