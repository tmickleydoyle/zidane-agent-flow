/**
 * Several zidane processes can run this extension at once: the desktop app's
 * main process (panels, appearance), the daemon (where runs execute when
 * "use daemon" is on), terminal sessions. Each records what its own agents
 * do. Peers find each other through one small file per process in a per-user
 * temp directory, and every server shows the union.
 */
import { mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

export interface PeerInfo {
  pid: number
  port: number
  /** desktop | daemon | terminal */
  kind: string
  startedAt: number
}

export interface PeerDirectory {
  /** Announce this process's server. */
  register: (port: number) => void
  unregister: () => void
  /** Live peers, this process excluded. Entries of dead processes are removed. */
  list: () => PeerInfo[]
}

/** Which kind of zidane process this is, for labels and history files. */
export function hostKind(): string {
  if (process.versions.electron)
    return 'desktop'
  return process.argv.some(arg => /daemon|server-cli/.test(arg)) ? 'daemon' : 'terminal'
}

/** `AGENT_FLOW_PEERS_DIR` overrides it (tests, or keeping two setups apart). */
export function defaultPeerDir(): string {
  if (process.env.AGENT_FLOW_PEERS_DIR)
    return process.env.AGENT_FLOW_PEERS_DIR
  const uid = typeof process.getuid === 'function' ? process.getuid() : 'user'
  return join(tmpdir(), `zidane-agent-flow-${uid}`, 'peers')
}

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  }
  catch (error) {
    return (error as NodeJS.ErrnoException).code === 'EPERM'
  }
}

export function createPeerDirectory(dir = defaultPeerDir(), self = { pid: process.pid, kind: hostKind() }): PeerDirectory {
  let file: string | undefined
  return {
    register(port) {
      try {
        mkdirSync(dir, { recursive: true })
        file = join(dir, `${self.pid}-${port}.json`)
        const info: PeerInfo = { pid: self.pid, port, kind: self.kind, startedAt: Date.now() }
        writeFileSync(file, JSON.stringify(info))
      }
      catch {
        file = undefined
      }
    },
    unregister() {
      if (file)
        rmSync(file, { force: true })
      file = undefined
    },
    list() {
      let names: string[]
      try {
        names = readdirSync(dir)
      }
      catch {
        return []
      }
      const peers: PeerInfo[] = []
      for (const name of names) {
        if (!name.endsWith('.json'))
          continue
        const path = join(dir, name)
        let info: PeerInfo
        try {
          info = JSON.parse(readFileSync(path, 'utf8')) as PeerInfo
        }
        catch {
          continue
        }
        if (!Number.isInteger(info.pid) || !Number.isInteger(info.port))
          continue
        if (path === file)
          continue
        if (!alive(info.pid)) {
          rmSync(path, { force: true })
          continue
        }
        peers.push(info)
      }
      return peers
    },
  }
}
