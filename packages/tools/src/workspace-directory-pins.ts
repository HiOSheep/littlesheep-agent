import { spawn } from 'node:child_process'

export type PinnedDirectoryResult<T> =
  | { ok: true; value: T }
  | { ok: false; reason: string }

// The script is host-authored code. Paths arrive as JSON in the environment and are never
// interpolated into executable PowerShell. Each native directory handle denies
// delete sharing until the file operation finishes. Write sharing is required
// for child-file replacement; this does not isolate other same-user processes.
const PIN_SCRIPT = String.raw`
[Console]::InputEncoding = [Text.UTF8Encoding]::new($false)
[Console]::OutputEncoding = [Text.UTF8Encoding]::new($false)
$ErrorActionPreference = 'Stop'
Add-Type -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class LsDirectoryPins {
  [StructLayout(LayoutKind.Sequential)]
  private struct FileInfo {
    public uint Attributes;
    public System.Runtime.InteropServices.ComTypes.FILETIME Creation;
    public System.Runtime.InteropServices.ComTypes.FILETIME Access;
    public System.Runtime.InteropServices.ComTypes.FILETIME Write;
    public uint Volume, SizeHigh, SizeLow, Links, IndexHigh, IndexLow;
  }
  [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  private static extern SafeFileHandle CreateFileW(string path, uint access, uint share,
    IntPtr security, uint creation, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError = true)]
  private static extern bool GetFileInformationByHandle(SafeFileHandle handle, out FileInfo info);
  private static readonly List<SafeFileHandle> Handles = new List<SafeFileHandle>();
  public static void Pin(string path) {
    // GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE (no DELETE), OPEN_EXISTING,
    // FILE_FLAG_BACKUP_SEMANTICS | FILE_FLAG_OPEN_REPARSE_POINT.
    SafeFileHandle handle = CreateFileW(path, 0x80000000, 3, IntPtr.Zero, 3, 0x02200000, IntPtr.Zero);
    if (handle.IsInvalid) {
      handle.Dispose();
      throw new System.ComponentModel.Win32Exception(Marshal.GetLastWin32Error());
    }
    FileInfo info;
    if (!GetFileInformationByHandle(handle, out info)
        || (info.Attributes & 0x10) == 0 || (info.Attributes & 0x400) != 0
        || (info.IndexHigh == 0 && info.IndexLow == 0)) {
      handle.Dispose();
      throw new InvalidOperationException("Directory identity or reparse-point check failed.");
    }
    Handles.Add(handle);
  }
  public static void Release() {
    foreach (SafeFileHandle handle in Handles) handle.Dispose();
    Handles.Clear();
  }
}
'@
try {
  $request = [Environment]::GetEnvironmentVariable('LS_WORKSPACE_PIN_REQUEST') | ConvertFrom-Json
  if ($null -eq $request -or $request.directories.Count -eq 0) { throw 'Missing native pin request' }
  foreach ($directory in $request.directories) { [LsDirectoryPins]::Pin([string]$directory) }
  [Console]::Out.WriteLine('LS_DIRECTORY_PINS_READY')
  [Console]::Out.Flush()
  # PowerShell can consume redirected stdin before the script starts. Lifetime
  # is tied to the parent process instead; the parent terminates this helper on
  # completion, and its own exit also releases all native handles.
  $parentProcess = [Diagnostics.Process]::GetProcessById([int]$request.parentPid)
  $parentProcess.WaitForExit()
} catch {
  [Console]::Error.WriteLine('LS_DIRECTORY_PINS_UNAVAILABLE')
  exit 1
} finally {
  [LsDirectoryPins]::Release()
}
`

/** Keep Windows directory identities fixed throughout a native file operation. */
export async function withPinnedWorkspaceDirectories<T>(
  directories: readonly string[],
  revalidate: () => Promise<boolean>,
  operation: (isLeaseActive: () => boolean) => Promise<T>,
): Promise<PinnedDirectoryResult<T>> {
  if (process.platform !== 'win32') return { ok: false, reason: 'native directory pins are unavailable on this platform' }
  const child = spawn('powershell.exe', [
    '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(PIN_SCRIPT, 'utf16le').toString('base64'),
  ], {
    stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true,
    env: { ...process.env, LS_WORKSPACE_PIN_REQUEST: JSON.stringify({ directories, parentPid: process.pid }) },
  })
  const closed = new Promise<void>((resolve) => {
    child.once('close', () => resolve())
    child.once('error', () => resolve())
  })
  let active = false
  try {
    active = await new Promise<boolean>((resolve) => {
      let output = ''
      const timer = setTimeout(() => finish(false), 15_000)
      const finish = (ready: boolean) => {
        clearTimeout(timer)
        child.stdout.removeListener('data', onData)
        child.removeListener('error', onError)
        child.removeListener('exit', onExit)
        resolve(ready)
      }
      const onData = (chunk: Buffer) => {
        output = (output + chunk.toString('utf8')).slice(-1_024)
        if (output.includes('LS_DIRECTORY_PINS_READY')) finish(true)
      }
      const onError = () => finish(false)
      const onExit = () => finish(false)
      child.stdout.on('data', onData)
      child.once('error', onError)
      child.once('exit', onExit)
      child.stdin.on('error', () => undefined)
      child.stderr.resume()
    })
    if (!active) return { ok: false, reason: 'native directory handles could not be acquired' }
    if (!await revalidate() || child.exitCode !== null || child.signalCode !== null) {
      return { ok: false, reason: 'workspace identity or native directory lease changed before execution' }
    }
    const isLeaseActive = () => child.exitCode === null && child.signalCode === null && !child.killed
    const value = await operation(isLeaseActive)
    return isLeaseActive()
      ? { ok: true, value }
      : { ok: false, reason: 'the native directory lease ended during execution' }
  } finally {
    child.stdin.end()
    child.kill()
    let timer: ReturnType<typeof setTimeout> | undefined
    await Promise.race([
      closed,
      new Promise<void>((resolve) => { timer = setTimeout(() => { child.kill(); resolve() }, 2_000) }),
    ])
    if (timer) clearTimeout(timer)
  }
}
