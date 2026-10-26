[CmdletBinding()]
param(
  [ValidateRange(1, 65535)]
  [int]$ApiPort = 58321,

  [string]$ServerName = 'staruml',

  [string]$CodexPath,

  [switch]$SkipBuild
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step {
  param([string]$Message)
  Write-Host "`n==> $Message" -ForegroundColor Cyan
}

function Get-RequiredCommand {
  param([string]$Name)

  $command = Get-Command $Name -ErrorAction SilentlyContinue
  if (-not $command) {
    throw "Required command '$Name' was not found on PATH."
  }
  return $command
}

function Resolve-CodexExecutablePath {
  param([string]$ExplicitPath)

  $candidates = [System.Collections.Generic.List[string]]::new()

  if (-not [string]::IsNullOrWhiteSpace($ExplicitPath)) {
    $candidates.Add($ExplicitPath)
  }

  if (-not [string]::IsNullOrWhiteSpace($env:CODEX_CLI_PATH)) {
    $candidates.Add($env:CODEX_CLI_PATH)
  }

  $pathCommand = Get-Command 'codex' -ErrorAction SilentlyContinue
  if ($pathCommand) {
    $pathValue = if ($pathCommand.PSObject.Properties['Path']) {
      $pathCommand.Path
    } else {
      $pathCommand.Source
    }
    if (-not [string]::IsNullOrWhiteSpace($pathValue)) {
      $candidates.Add($pathValue)
    }
  }

  $codexBinRoot = Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\bin'
  if (Test-Path -LiteralPath $codexBinRoot -PathType Container) {
    Get-ChildItem -LiteralPath $codexBinRoot -Filter 'codex.exe' -File -Recurse |
      Sort-Object LastWriteTimeUtc -Descending |
      ForEach-Object { $candidates.Add($_.FullName) }
  }

  $candidates.Add((Join-Path $env:LOCALAPPDATA 'OpenAI\Codex\codex.exe'))
  $candidates.Add((Join-Path $env:LOCALAPPDATA 'Programs\Codex\codex.exe'))

  foreach ($candidate in $candidates) {
    if ([string]::IsNullOrWhiteSpace($candidate)) { continue }

    $resolved = $ExecutionContext.SessionState.Path.GetUnresolvedProviderPathFromPSPath(
      $candidate
    )
    if (
      [System.IO.Path]::IsPathRooted($resolved) -and
      (Test-Path -LiteralPath $resolved -PathType Leaf)
    ) {
      return [System.IO.Path]::GetFullPath($resolved)
    }
  }

  throw @"
Could not find the Codex executable. The installer checked CODEX_CLI_PATH,
PowerShell PATH, and the Codex Desktop installation under:
  $codexBinRoot

Run the installer with an explicit path, for example:
  .\install.ps1 -CodexPath 'C:\full\path\to\codex.exe'
"@
}

function Invoke-Codex {
  param(
    [string[]]$Arguments,
    [switch]$Quiet
  )

  # Windows PowerShell turns native stderr into ErrorRecord objects. Codex may
  # emit harmless warnings there, so use its process exit code as the source of
  # truth instead of letting ErrorActionPreference terminate the installer.
  $previousErrorActionPreference = $ErrorActionPreference
  $ErrorActionPreference = 'Continue'
  try {
    if ($Quiet) {
      & $script:resolvedCodexPath @Arguments *> $null
    } else {
      & $script:resolvedCodexPath @Arguments 2>&1 | Out-Host
    }
    $exitCode = $LASTEXITCODE
  } finally {
    $ErrorActionPreference = $previousErrorActionPreference
  }
  return $exitCode
}

$repoRoot = Split-Path -Parent $PSCommandPath
$entryPoint = Join-Path $repoRoot 'build\index.js'
$extensionSource = Join-Path $repoRoot 'staruml-v4-extension'
$extensionRoot = Join-Path $env:APPDATA 'StarUML\extensions\user'
$extensionTarget = Join-Path $extensionRoot 'staruml-mcp-bridge-v4'

$node = Get-RequiredCommand 'node'
$npm = Get-RequiredCommand 'npm'
$resolvedCodexPath = Resolve-CodexExecutablePath -ExplicitPath $CodexPath

$nodeVersionText = (& $node.Source --version).TrimStart('v')
$nodeMajor = [int]($nodeVersionText.Split('.')[0])
if ($nodeMajor -lt 22) {
  throw "Node.js 22 or newer is required. Found $nodeVersionText."
}

if (-not $SkipBuild) {
  Write-Step 'Installing dependencies and building the MCP server'
  & $npm.Source ci
  if ($LASTEXITCODE -ne 0) { throw "npm ci failed with exit code $LASTEXITCODE." }

  & $npm.Source run build
  if ($LASTEXITCODE -ne 0) { throw "npm run build failed with exit code $LASTEXITCODE." }
}

if (-not (Test-Path -LiteralPath $entryPoint -PathType Leaf)) {
  throw "The built MCP server was not found at '$entryPoint'. Run without -SkipBuild."
}
if (-not (Test-Path -LiteralPath $extensionSource -PathType Container)) {
  throw "The StarUML extension was not found at '$extensionSource'."
}

Write-Step 'Installing the StarUML 4 extension'
New-Item -ItemType Directory -Path $extensionTarget -Force | Out-Null
Get-ChildItem -LiteralPath $extensionSource -Force |
  Where-Object { $_.Name -ne 'types' } |
  Copy-Item -Destination $extensionTarget -Recurse -Force

Write-Step "Registering '$ServerName' with Codex"
Write-Host "Codex executable: $resolvedCodexPath"
$getExitCode = Invoke-Codex -Arguments @('mcp', 'get', $ServerName) -Quiet
if ($getExitCode -eq 0) {
  $removeExitCode = Invoke-Codex -Arguments @('mcp', 'remove', $ServerName)
  if ($removeExitCode -ne 0) {
    throw "Could not replace the existing Codex MCP server '$ServerName'."
  }
}

$addExitCode = Invoke-Codex -Arguments @(
  'mcp', 'add', $ServerName, '--', $node.Source, $entryPoint, "--api-port=$ApiPort"
)
if ($addExitCode -ne 0) {
  throw "Could not register the Codex MCP server '$ServerName'."
}

Write-Step 'Verifying the Codex registration'
$verifyExitCode = Invoke-Codex -Arguments @('mcp', 'get', $ServerName)
if ($verifyExitCode -ne 0) {
  throw "Codex did not return the newly registered MCP server '$ServerName'."
}

$starUmlRunning = Get-Process -Name 'StarUML' -ErrorAction SilentlyContinue
Write-Host "`nInstallation complete." -ForegroundColor Green
Write-Host "Codex MCP server: $ServerName"
Write-Host "StarUML extension: $extensionTarget"
Write-Host "StarUML bridge: http://127.0.0.1:$ApiPort"

if ($starUmlRunning) {
  Write-Warning 'StarUML is running. Restart it to load the newly installed extension.'
} else {
  Write-Host 'Start StarUML to load the bridge. Its status is available under Tools > StarUML MCP Bridge.'
}

Write-Host 'Restart Codex (or open a new Codex session) before using the new MCP tools.'
