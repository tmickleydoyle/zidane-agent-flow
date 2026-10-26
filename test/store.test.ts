import { describe, expect, it } from 'bun:test'
import { computeStats, FlowStore, ROOT, summarizeInput } from '../src/store'

function clock(start = 1000) {
  let t = start
  return { now: () => t, tick: (ms: number) => void (t += ms) }
}

describe('FlowStore', () => {
  it('builds run → turn → tool, with timing and status', () => {
    const c = clock()
    const store = new FlowStore({}, c.now)
    const r = store.startRun({ runId: 'run_1', sessionId: 's1', prompt: 'fix the bug' }).id
    expect(r).toBe('s1/run_1')
    store.turnStart(r, ROOT, 'u1', 0)
    store.turnText(r, ROOT, 'u1', 'text', 'Looking at the code')
    c.tick(50)
    // zidane fires turn:after before the turn's tools run.
    store.turnEnd(r, ROOT, 'u1', { turn: 0, usage: { input: 10, output: 5, cost: 0.01 } })
    const turn = store.getRun(r)!.root.children[0]!
    expect(turn.status).toBe('success')
    store.toolStart(r, ROOT, { turnId: 'u1', callId: 'c1', name: 'shell', input: { command: 'ls -la' } })
    expect(turn.status).toBe('running')
    c.tick(200)
    store.toolEnd(r, ROOT, 'c1', { result: 'file.ts', isError: false, outputBytes: 7 })
    expect(turn).toMatchObject({ status: 'success', endedAt: 1250, data: { llmMs: 50 } })
    store.endRun(r, 'completed')

    const run = store.getRun(r)!
    expect(run.status).toBe('success')
    expect(run.root.label).toBe('fix the bug')
    expect(turn).toMatchObject({ kind: 'turn', label: 'Turn 1', detail: 'Looking at the code' })
    const tool = turn.children[0]!
    expect(tool).toMatchObject({ kind: 'tool', label: 'shell', detail: 'ls -la', status: 'success' })
    expect(tool.endedAt! - tool.startedAt).toBe(200)
    expect(tool.data.output).toBe('file.ts')
    expect(computeStats(run)).toMatchObject({ turns: 1, tools: 1, agents: 0, errors: 0, tokensIn: 10, tokensOut: 5, cost: 0.01 })
    expect(store.currentRunId('s1')).toBe(r)
  })

  it('keys runs by session, since run ids repeat across agents', () => {
    const store = new FlowStore()
    const a = store.startRun({ runId: 'run_1', sessionId: 'a' }).id
    const b = store.startRun({ runId: 'run_1', sessionId: 'b' }).id
    expect(a).not.toBe(b)
    expect(store.listRuns()).toHaveLength(2)
  })

  it('nests subagents under their spawn call, keyed by spawn call id', () => {
    const store = new FlowStore()
    const r = store.startRun({ runId: 'run_1' }).id
    store.toolStart(r, ROOT, { turnId: 'u1', callId: 'spawn1', name: 'spawn', input: { task: 'research' } })
    store.agentStart(r, { childId: 'child-1', task: 'research', callId: 'spawn1', depth: 1 })
    store.toolStart(r, 'spawn1', { turnId: 'cu1', callId: 'spawn2', name: 'spawn', input: { task: 'deeper' } })
    // Every agent's first child is child-1.
    store.agentStart(r, { childId: 'child-1', task: 'deeper', callId: 'spawn2', depth: 2 })
    store.toolStart(r, 'spawn2', { turnId: 'gu1', callId: 'g1', name: 'grep', input: { pattern: 'TODO' } })

    const spawn = store.getRun(r)!.root.children[0]!.children[0]!
    const child = spawn.children[0]!
    expect(child).toMatchObject({ kind: 'agent', label: 'child-1', depth: 1 })
    const grand = child.children[0]!.children[0]!.children[0]!
    expect(grand).toMatchObject({ kind: 'agent', label: 'child-1', depth: 2, detail: 'deeper' })
    expect(grand.children[0]!.children[0]).toMatchObject({ kind: 'tool', detail: 'TODO' })
    expect(store.findAgent(r, 'child-1', 2)).toBe('spawn2')
    expect(store.findAgent(r, 'child-1', 1)).toBe('spawn1')
    expect(store.turnAgent(r, 'gu1')).toBe('spawn2')

    store.agentEnd(r, 'spawn2', { status: 'completed' })
    expect(grand.status).toBe('success')
    expect(grand.children[0]!.children[0]!.status).toBe('success')
  })

  it('moves a subagent turn placed by child id once a tool names its spawn call', () => {
    const store = new FlowStore()
    const r = store.startRun({ runId: 'run_1' }).id
    store.agentStart(r, { childId: 'child-1', task: 'a', callId: 's1', depth: 1 })
    store.agentStart(r, { childId: 'child-1', task: 'b', callId: 's2', depth: 1 })
    // Text arrives first: the newest matching agent (s2) gets the turn.
    store.turnText(r, store.findAgent(r, 'child-1', 1)!, 'tu', 'text', 'hi')
    expect(store.turnAgent(r, 'tu')).toBe('s2')
    store.toolStart(r, 's1', { turnId: 'tu', callId: 'c', name: 'echo' })
    expect(store.turnAgent(r, 'tu')).toBe('s1')
  })

  it('nests codemode tool calls under the codemode call', () => {
    const store = new FlowStore()
    const r = store.startRun({ runId: 'run_1' }).id
    store.toolStart(r, ROOT, { turnId: 'u1', callId: 'cm', name: 'codemode', input: { code: 'await tools.grep()' } })
    store.toolStart(r, ROOT, { turnId: 'u1', callId: 'inner', name: 'grep', input: { pattern: 'x' }, parentToolCallId: 'cm' })
    const turn = store.getRun(r)!.root.children[0]!
    expect(turn.children).toHaveLength(1)
    expect(turn.children[0]!.children[0]!.id).toBe('t:inner')
    expect(store.getRun(r)!.sessionId).toBe('local')
  })

  it('closes open nodes when the run ends, and marks errors', () => {
    const store = new FlowStore()
    const r = store.startRun({ runId: 'run_1' }).id
    store.toolStart(r, ROOT, { turnId: 'u1', callId: 'a', name: 'shell' })
    store.toolStart(r, ROOT, { turnId: 'u1', callId: 'b', name: 'shell' })
    store.toolEnd(r, ROOT, 'b', { error: 'boom' })
    store.endRun(r, 'aborted')
    const [a, b] = store.getRun(r)!.root.children[0]!.children
    expect(a!.status).toBe('cancelled')
    expect(b).toMatchObject({ status: 'error', data: { error: 'boom' } })
    expect(store.getRun(r)!.status).toBe('cancelled')
  })

  it('round-trips through serialize/hydrate and marks open runs interrupted', () => {
    const store = new FlowStore()
    const r = store.startRun({ runId: 'run_1', sessionId: 's1' }).id
    store.toolStart(r, ROOT, { turnId: 'u1', callId: 'a', name: 'shell' })
    const copy = new FlowStore()
    expect(copy.hydrate(JSON.parse(JSON.stringify(store.serialize())))).toBe(1)
    const run = copy.getRun(r)!
    expect(run.status).toBe('cancelled')
    expect(run.root.children[0]!.children[0]!.status).toBe('cancelled')
    // The indexes are rebuilt: later events still find nodes and parents.
    copy.toolEnd(r, ROOT, 'a', { result: 'late' })
    expect(run.root.children[0]!.children[0]!.data.output).toBe('late')
    expect(copy.turnAgent(r, 'u1')).toBe(ROOT)
    expect(copy.currentRunId('s1')).toBe(r)
    expect(copy.hydrate({ version: 2 })).toBe(0)
  })

  it('evicts the oldest finished runs and caps nodes per run', () => {
    const c = clock()
    const store = new FlowStore({ maxRuns: 2, maxNodesPerRun: 3 }, c.now)
    for (const id of ['a', 'b', 'c']) {
      store.startRun({ runId: id })
      store.endRun(`local/${id}`, 'completed')
      c.tick(10)
    }
    expect(store.listRuns().map(r => r.id)).toEqual(['local/c', 'local/b'])
    const d = store.startRun({ runId: 'd' }).id
    store.toolStart(d, ROOT, { turnId: 'u', callId: '1', name: 'x' })
    store.toolStart(d, ROOT, { turnId: 'u', callId: '2', name: 'x' })
    expect(store.getRun(d)!.truncated).toBe(true)
  })

  it('notifies listeners and survives a throwing one', () => {
    const store = new FlowStore()
    const seen: string[] = []
    store.subscribe(() => {
      throw new Error('bad listener')
    })
    store.subscribe(id => void seen.push(id))
    store.startRun({ runId: 'r1' })
    expect(seen).toEqual(['local/r1'])
  })
})

describe('FlowStore with many sessions', () => {
  it('summarizes what each open run is doing now, and caches by version', () => {
    const c = clock()
    const store = new FlowStore({}, c.now)
    const a = store.startRun({ runId: 'run_1', sessionId: 'a' }).id
    const b = store.startRun({ runId: 'run_1', sessionId: 'b' }).id
    store.turnStart(a, ROOT, 'ua', 0)
    c.tick(5)
    store.toolStart(a, ROOT, { turnId: 'ua', callId: 'sa', name: 'spawn', input: { task: 't' } })
    c.tick(5)
    store.agentStart(a, { childId: 'child-1', task: 't', callId: 'sa', depth: 1 })
    c.tick(5)
    store.toolStart(a, 'sa', { turnId: 'cu', callId: 'g', name: 'grep', input: { pattern: 'x' } })
    store.turnStart(b, ROOT, 'ub', 0)
    store.endRun(b, 'completed')

    const [first, second] = store.listRuns()
    const runA = [first, second].find(r => r!.id === a)!
    const runB = [first, second].find(r => r!.id === b)!
    expect(runA.activity).toMatchObject({ kind: 'tool', label: 'grep', detail: 'x', data: { tool: 'grep' } })
    expect(runA.helpersRunning).toBe(1)
    expect(runB.activity).toBeUndefined()
    expect(store.listRuns().find(r => r.id === a)).toBe(runA)
    store.toolEnd(a, 'sa', 'g', { result: 'ok' })
    expect(store.listRuns().find(r => r.id === a)!.activity!.kind).not.toBe('tool')
  })

  it('names a sole open run, but refuses to guess between several', () => {
    const store = new FlowStore()
    const a = store.startRun({ runId: 'run_1', sessionId: 'a' }).id
    expect(store.soleOpenRun()).toBe(a)
    store.startRun({ runId: 'run_1', sessionId: 'b' })
    expect(store.soleOpenRun()).toBeUndefined()
    expect(store.openRunCount()).toBe(2)
  })
})

describe('FlowStore never shows phantom running requests', () => {
  it('closes a request that never reported its end when the next one starts in that conversation', () => {
    const store = new FlowStore()
    const first = store.startRun({ runId: 'run_1', sessionId: 's' }).id
    store.toolStart(first, ROOT, { turnId: 'u', callId: 'c', name: 'shell' })
    const other = store.startRun({ runId: 'run_1', sessionId: 'elsewhere' }).id
    const second = store.startRun({ runId: 'run_2', sessionId: 's' }).id
    expect(store.getRun(first)).toMatchObject({ status: 'cancelled', endedBy: 'inferred' })
    expect(store.getRun(first)!.root.children[0]!.children[0]!.status).toBe('cancelled')
    expect(store.getRun(first)!.root.data.error).toContain('newer request')
    expect(store.getRun(second)!.status).toBe('running')
    // Other conversations are untouched.
    expect(store.getRun(other)!.status).toBe('running')
  })

  it('closes a conversation when the host says it settled, and reopens a run that reports again', () => {
    const store = new FlowStore()
    const r = store.startRun({ runId: 'run_1', sessionId: 's' }).id
    expect(store.closeSession('s')).toBe(1)
    expect(store.openRunCount()).toBe(0)
    expect(store.closeSession('s')).toBe(0)
    // It was still alive after all: its next event brings it back.
    store.turnStart(r, ROOT, 'u1', 0)
    expect(store.getRun(r)).toMatchObject({ status: 'running' })
    expect(store.getRun(r)!.endedBy).toBeUndefined()
    expect(store.getRun(r)!.root.data.error).toBeUndefined()
  })

  it('never lets an inferred close override a real end', () => {
    const store = new FlowStore()
    const r = store.startRun({ runId: 'run_1', sessionId: 's' }).id
    store.endRun(r, 'completed')
    store.closeSession('s')
    expect(store.getRun(r)).toMatchObject({ status: 'success', endedBy: 'event' })
    store.turnStart(r, ROOT, 'late', 0)
    expect(store.getRun(r)!.status).toBe('success')
  })

  it('records when a run last reported', () => {
    const c = clock()
    const store = new FlowStore({}, c.now)
    const r = store.startRun({ runId: 'run_1', sessionId: 's' }).id
    c.tick(90_000)
    store.turnStart(r, ROOT, 'u', 0)
    expect(store.listRuns()[0]!.lastEventAt).toBe(91_000)
  })
})

describe('summarizeInput', () => {
  it('picks the most telling field', () => {
    expect(summarizeInput({ command: 'git  status\n' })).toBe('git status')
    expect(summarizeInput({ paths: ['a', 'b'] })).toBe('2 paths')
    expect(summarizeInput({ other: 'x' })).toBe('x')
    expect(summarizeInput({})).toBeUndefined()
  })
})
