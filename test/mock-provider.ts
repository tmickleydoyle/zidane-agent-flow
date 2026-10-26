import type { Provider, SessionMessage, ToolResult, ToolSpec } from 'zidane'

/** Scripted turns for a provider that needs no network. */
export interface MockTurn {
  text: string
  thinking?: string
  toolCalls?: { id: string, name: string, input: Record<string, unknown> }[]
  delayMs?: number
  /** Pause between streamed words (live demos). */
  chunkDelayMs?: number
  throwError?: unknown
}

/** A minimal zidane provider that replays `turns` in order (modeled on zidane's test/mock-provider.ts). */
export function createMockProvider(turns: MockTurn[], name = 'mock'): Provider {
  let index = 0
  return {
    name,
    meta: { defaultModel: 'mock-model', isMock: true },
    formatTools: (tools: ToolSpec[]) => tools,
    userMessage: (content: string): SessionMessage => ({ role: 'user', content: [{ type: 'text', text: content }] }),
    assistantMessage: (content: string): SessionMessage => ({ role: 'assistant', content: [{ type: 'text', text: content }] }),
    toolResultsMessage: (results: ToolResult[]): SessionMessage => ({
      role: 'user',
      content: results.map(r => ({ type: 'tool_result' as const, callId: r.id, output: r.content, ...(r.isError ? { isError: true as const } : {}) })),
    }),
    async stream(options, callbacks) {
      const turn = turns[index++] ?? { text: 'No more turns.' }
      if (turn.delayMs)
        await new Promise(resolve => setTimeout(resolve, turn.delayMs))
      if (turn.throwError !== undefined)
        throw turn.throwError
      if (turn.thinking)
        callbacks.onThinking?.(turn.thinking)
      for (const word of turn.text.match(/\S+\s*/g) ?? []) {
        callbacks.onText(word)
        if (turn.chunkDelayMs)
          await new Promise(resolve => setTimeout(resolve, turn.chunkDelayMs))
      }
      const toolCalls = turn.toolCalls ?? []
      const content: SessionMessage['content'] = []
      if (turn.thinking)
        content.push({ type: 'thinking', text: turn.thinking })
      if (turn.text)
        content.push({ type: 'text', text: turn.text })
      for (const tc of toolCalls)
        content.push({ type: 'tool_call', id: tc.id, name: tc.name, input: tc.input })
      return {
        assistantMessage: { role: 'assistant', content },
        text: turn.text,
        toolCalls,
        done: toolCalls.length === 0,
        usage: { input: 120, output: turn.text.length, cost: 0.0012, modelId: options.model ?? 'mock-model' },
      }
    },
  }
}
