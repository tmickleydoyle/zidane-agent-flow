import type { PanelContent, PanelItem, PanelRowItem } from 'zidane'
import type { FlowNode, FlowRun, NodeStatus } from './store'
import { computeStats } from './store'

const STATUS_ICON: Record<NodeStatus, { gui: string, tui: string }> = {
  queued: { gui: 'i-ph-circle-dashed', tui: '○' },
  running: { gui: 'i-ph-circle-half-fill', tui: '◐' },
  success: { gui: 'i-ph-check-circle-fill', tui: '●' },
  error: { gui: 'i-ph-x-circle-fill', tui: '✕' },
  cancelled: { gui: 'i-ph-prohibit', tui: '⊘' },
}

const STATUS_TONE = {
  queued: 'muted',
  running: 'warn',
  success: 'success',
  error: 'danger',
  cancelled: 'subtle',
} as const

export function formatDuration(ms: number): string {
  if (ms < 1000)
    return `${Math.max(0, Math.round(ms))}ms`
  const s = ms / 1000
  if (s < 60)
    return `${s < 10 ? s.toFixed(1) : Math.round(s)}s`
  const m = Math.floor(s / 60)
  const rest = Math.round(s % 60)
  if (m < 60)
    return `${m}m ${rest}s`
  return `${Math.floor(m / 60)}h ${m % 60}m`
}

export function formatTokens(n: number): string {
  if (n >= 1_000_000)
    return `${(n / 1_000_000).toFixed(1)}M`
  if (n >= 1000)
    return `${(n / 1000).toFixed(1)}k`
  return String(n)
}

function duration(node: FlowNode, now: number): string {
  return formatDuration((node.endedAt ?? now) - node.startedAt)
}

function row(node: FlowNode, now: number, details?: PanelItem[]): PanelRowItem {
  return {
    kind: 'row',
    id: node.id,
    title: node.label,
    ...(node.detail ? { subtitle: node.detail } : {}),
    status: node.status,
    icon: STATUS_ICON[node.status],
    tone: STATUS_TONE[node.status],
    facts: [{ text: duration(node, now) }],
    ...(details && details.length > 0 ? { details: details.slice(0, 50), expanded: node.status === 'running' } : {}),
  }
}

/** Flatten a turn's tools and subagents into one level of rows (panels nest one level). */
function turnDetails(turn: FlowNode, now: number): PanelItem[] {
  const out: PanelItem[] = []
  const walk = (node: FlowNode, prefix: string): void => {
    for (const child of node.children) {
      const r = row(child, now)
      out.push({ ...r, title: `${prefix}${r.title}` })
      if (child.kind !== 'turn')
        walk(child, `${prefix}  `)
    }
  }
  walk(turn, '')
  return out
}

export function buildPanel(run: FlowRun | undefined, url: string | undefined, now = Date.now()): PanelContent {
  const open = url ? [{ kind: 'row' as const, title: 'Open Agent Flow', subtitle: 'Tree, timeline and graph view', href: url, icon: { gui: 'i-ph-git-merge', tui: '⑂' } }] : []
  if (!run) {
    return {
      sections: url ? [{ id: 'open', items: open }] : [],
      empty: 'No runs yet. Send a prompt to see how the agent works.',
    }
  }
  const stats = computeStats(run)
  const runUrl = url ? `${url}?run=${encodeURIComponent(run.id)}` : undefined
  return {
    badge: run.status === 'running' ? '●' : 0,
    sections: [
      {
        id: 'summary',
        items: [
          ...(runUrl ? [{ ...open[0]!, href: runUrl }] : []),
          {
            kind: 'kv',
            rows: [
              { label: 'status', value: run.status },
              { label: 'duration', value: duration(run.root, now) },
              { label: 'turns', value: String(stats.turns) },
              { label: 'tools', value: String(stats.tools) },
              { label: 'subagents', value: String(stats.agents) },
              { label: 'tokens', value: `${formatTokens(stats.tokensIn)} in · ${formatTokens(stats.tokensOut)} out` },
              ...(stats.cost > 0 ? [{ label: 'cost', value: `$${stats.cost.toFixed(4)}` }] : []),
            ],
          },
        ],
      },
      {
        id: 'tree',
        title: run.prompt ? `Latest run · ${run.root.label}` : 'Latest run',
        items: run.root.children.slice(-50).map(child => row(child, now, child.kind === 'turn' || child.kind === 'agent' ? turnDetails(child, now) : undefined)),
      },
    ],
    actions: [{ id: 'open', label: 'Open visualizer' }],
    empty: 'Waiting for the first turn…',
  }
}
