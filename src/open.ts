import { spawn } from 'node:child_process'

/** Open a URL in the user's default browser. */
export function openInBrowser(url: string): void {
  const [cmd, args] = process.platform === 'darwin'
    ? ['open', [url]]
    : process.platform === 'win32'
      ? ['cmd', ['/c', 'start', '', url]]
      : ['xdg-open', [url]]
  try {
    const child = spawn(cmd, args as string[], { detached: true, stdio: 'ignore' })
    child.on('error', () => {})
    child.unref()
  }
  catch {}
}
