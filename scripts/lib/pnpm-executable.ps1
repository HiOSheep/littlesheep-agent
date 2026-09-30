# Resolve the pnpm executable for the PowerShell entry scripts.
#
# pnpm is not guaranteed to be on PATH: this checkout is developed on a machine whose user
# `.npmrc` sets `prefix=` to a directory that no shell profile exports, so a bare `pnpm.cmd`
# in a shortcut-launched or `-NoProfile` script fails as `'pnpm.cmd' is not recognized` and
# the app never starts. The Node-side toolchain already answers this question —
# `scripts/lib/pnpm-invocation.mjs` searches an explicit override, PATH, PNPM_HOME, the npm
# prefix and the usual install directories, and names every path it looked at when it fails.
# These entry scripts ask that same resolver rather than keeping a second search order that
# would drift from it.
function Resolve-PnpmExecutable {
  param([Parameter(Mandatory = $true)][string]$RepoRoot)

  $nodeCommand = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if (-not $nodeCommand) {
    throw 'node was not found on PATH. LittleSheep needs Node.js 20.9+ to resolve pnpm and to run the build.'
  }
  $resolver = Join-Path $RepoRoot 'scripts\lib\pnpm-invocation.mjs'
  if (-not (Test-Path -LiteralPath $resolver)) {
    throw "The pnpm resolver is missing: $resolver"
  }

  # Judge the helper by its exit code, never by whether it wrote to stderr.
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    $script = 'import(process.argv[1]).then(m => process.stdout.write(m.resolvePnpmExecutable().executable)).catch(error => { console.error(error && error.message ? error.message : String(error)); process.exit(1) })'
    $output = @(& $nodeCommand.Source -e $script ([uri]$resolver).AbsoluteUri 2>&1 | ForEach-Object {
      if ($_ -is [System.Management.Automation.ErrorRecord]) { $_.ToString() } else { "$_" }
    })
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  if ($exitCode -ne 0) {
    throw ($output -join [Environment]::NewLine)
  }

  $executable = "$($output | Select-Object -First 1)".Trim()
  if (-not $executable) {
    throw 'pnpm was not found, so LittleSheep cannot start.'
  }
  return $executable
}
