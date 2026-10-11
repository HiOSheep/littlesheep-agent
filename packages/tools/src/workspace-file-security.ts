import { execFile } from 'node:child_process'

// Read-only metadata inspection. Neither path is interpolated into script code;
// source permissions are never changed to make an automatic replacement work.
const SECURITY_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
try {
  $request = [Environment]::GetEnvironmentVariable('LS_FILE_SECURITY_REQUEST') | ConvertFrom-Json
  $source = Get-Item -LiteralPath $request.source -Force
  $replacement = Get-Item -LiteralPath $request.replacement -Force
  if ($source.PSIsContainer -or $replacement.PSIsContainer) { exit 1 }
  # Only plain writable files. Preserve other attributes/streams by declining
  # automatic replacement rather than guessing which metadata may be dropped.
  foreach ($file in @($source, $replacement)) {
    if (([int]$file.Attributes -band (-bnot 32)) -ne 0 -and [int]$file.Attributes -ne 128) { exit 1 }
    $streams = @(Get-Item -LiteralPath $file.FullName -Stream '*')
    if ($streams.Count -ne 1 -or $streams[0].Stream -notin @(':$DATA', '$DATA')) { exit 1 }
  }
  $sections = [Security.AccessControl.AccessControlSections]14 # DACL, owner, group
  $sourceSecurity = [IO.File]::GetAccessControl($source.FullName, $sections).GetSecurityDescriptorSddlForm($sections)
  $replacementSecurity = [IO.File]::GetAccessControl($replacement.FullName, $sections).GetSecurityDescriptorSddlForm($sections)
  if ($sourceSecurity -cne $replacementSecurity) { exit 1 }
  [Console]::Out.Write('LS_FILE_SECURITY_MATCH')
} catch { exit 1 }
`

/** Verify the real replacement already has the original ordinary file's ACL. */
export async function verifyReplacementSecurity(source: string, replacement: string): Promise<boolean> {
  if (process.platform !== 'win32') return false
  return new Promise<boolean>((resolve) => {
    execFile('powershell.exe', [
      '-NoProfile', '-NonInteractive', '-EncodedCommand', Buffer.from(SECURITY_SCRIPT, 'utf16le').toString('base64'),
    ], {
      windowsHide: true, timeout: 15_000, maxBuffer: 4_096,
      env: { ...process.env, LS_FILE_SECURITY_REQUEST: JSON.stringify({ source, replacement }) },
    }, (error, stdout) => resolve(!error && stdout === 'LS_FILE_SECURITY_MATCH'))
  })
}
