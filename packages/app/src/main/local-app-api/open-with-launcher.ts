import { spawn } from 'node:child_process'
import { HttpError } from './http.js'

/** A registered application can disappear between discovery and launch. */
export async function launchOpenWith(executable: string, args: string[]): Promise<void> {
  await new Promise<void>((resolve, reject) => {
    const child = spawn(executable, args, { detached: true, stdio: 'ignore', windowsHide: false })
    child.once('error', (error) => {
      reject(new HttpError(500, `无法启动所选应用：${error.message}`))
    })
    child.once('spawn', () => {
      child.unref()
      resolve()
    })
  })
}
