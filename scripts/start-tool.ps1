$ErrorActionPreference = 'Stop'
$projectRoot = Split-Path -Parent $PSScriptRoot
$webUrl = 'http://127.0.0.1:3000'

function Test-WebPage {
  param([string]$Url)
  try {
    $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
    return $response.StatusCode -ge 200 -and $response.StatusCode -lt 500
  } catch {
    return $false
  }
}

function Test-ListeningPort {
  param([int]$Port)
  return $null -ne (Get-NetTCPConnection -State Listen -LocalPort $Port -ErrorAction SilentlyContinue | Select-Object -First 1)
}

function Open-WebPage {
  param([string]$Url)
  $startInfo = [System.Diagnostics.ProcessStartInfo]::new($Url)
  $startInfo.UseShellExecute = $true
  [System.Diagnostics.Process]::Start($startInfo) | Out-Null
}

Write-Host ''
Write-Host 'AI Video Story Tool - One-click launcher' -ForegroundColor Cyan
Write-Host 'Close this window to stop the web service.' -ForegroundColor DarkGray
Write-Host ''

if (Test-WebPage -Url $webUrl) {
  Write-Host 'The tool is already running. Opening the web page...' -ForegroundColor Green
  Open-WebPage -Url $webUrl
  exit 0
}

if (Test-ListeningPort -Port 3000) {
  throw 'Port 3000 is already used by another program. Close it and try again.'
}

if (Test-ListeningPort -Port 3001) {
  throw 'Port 3001 is already used by another program. Close the old backend and try again.'
}

$npm = $null
$standardNpm = 'C:\Program Files\nodejs\npm.cmd'
if (Test-Path -LiteralPath $standardNpm) {
  $npm = $standardNpm
} else {
  $npmCommand = Get-Command npm.cmd -ErrorAction SilentlyContinue
  if ($npmCommand) { $npm = $npmCommand.Source }
}

if (-not $npm) {
  throw 'Node.js was not found. Install Node.js LTS and launch the tool again.'
}

$nodeDirectory = Split-Path -Parent $npm
$env:PATH = "$nodeDirectory;$env:PATH"

if (-not (Test-Path -LiteralPath (Join-Path $projectRoot 'node_modules'))) {
  throw 'Project dependencies are missing. Run npm install in the project folder first.'
}

$env:COMFYUI_MANAGED_LAUNCH_ENABLED = 'true'
$env:COMFYUI_AUTOSTART = 'true'

$browserJob = Start-Job -ArgumentList $webUrl -ScriptBlock {
  param($Url)
  $deadline = (Get-Date).AddMinutes(3)
  while ((Get-Date) -lt $deadline) {
    try {
      $response = Invoke-WebRequest -Uri $Url -UseBasicParsing -TimeoutSec 2
      if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) {
        $startInfo = [System.Diagnostics.ProcessStartInfo]::new($Url)
        $startInfo.UseShellExecute = $true
        [System.Diagnostics.Process]::Start($startInfo) | Out-Null
        return
      }
    } catch {
      Start-Sleep -Seconds 2
    }
  }
}

try {
  Set-Location -LiteralPath $projectRoot
  Write-Host 'Starting the web app, backend, and ComfyUI. Please wait...' -ForegroundColor Yellow
  Write-Host "Web address: $webUrl" -ForegroundColor DarkGray
  Write-Host ''
  & $npm run dev
  if ($LASTEXITCODE -ne 0) {
    throw "The service exited with error code $LASTEXITCODE."
  }
} finally {
  Stop-Job -Job $browserJob -ErrorAction SilentlyContinue
  Remove-Job -Job $browserJob -Force -ErrorAction SilentlyContinue
}
