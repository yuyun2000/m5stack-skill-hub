param(
  [ValidateSet("start", "stop", "restart", "status", "open", "logs")]
  [string]$Action = "status",

  [string]$BindAddress = "0.0.0.0",

  [ValidateRange(1, 65535)]
  [int]$Port = 8888,

  [switch]$Follow
)

$ErrorActionPreference = "Stop"

$ProjectRoot = (Resolve-Path (Join-Path $PSScriptRoot "..")).Path
$WebRoot = Join-Path $ProjectRoot "public"
$ServerScript = Join-Path $ProjectRoot "server\skill_share_server.py"
$DataDir = Join-Path $ProjectRoot "server\.data"
$RuntimeDir = Join-Path $PSScriptRoot ".runtime"
$PidFile = Join-Path $RuntimeDir "server.windows.pid"
$ConfigFile = Join-Path $RuntimeDir "server.windows.json"
$OutLogFile = Join-Path $RuntimeDir "server.windows.out.log"
$ErrLogFile = Join-Path $RuntimeDir "server.windows.err.log"

function Ensure-RuntimeDir {
  if (-not (Test-Path $RuntimeDir)) {
    New-Item -ItemType Directory -Path $RuntimeDir | Out-Null
  }
}

function Quote-Arg {
  param([string]$Value)
  if ($Value -match '[\s"]') {
    return '"' + ($Value -replace '"', '\"') + '"'
  }
  return $Value
}

function Resolve-Python {
  $candidates = @(
    @{ Name = "python"; Args = @() },
    @{ Name = "python3"; Args = @() },
    @{ Name = "py"; Args = @("-3") }
  )

  foreach ($candidate in $candidates) {
    $command = Get-Command $candidate.Name -ErrorAction SilentlyContinue
    if ($command) {
      return @{
        FilePath = $command.Source
        Args = $candidate.Args
      }
    }
  }

  throw "Python was not found. Install Python 3 and make sure python or py is available."
}

function Get-Config {
  if (-not (Test-Path $ConfigFile)) {
    return $null
  }

  try {
    return Get-Content -Path $ConfigFile -Raw | ConvertFrom-Json
  } catch {
    return $null
  }
}

function Get-ServerProcess {
  if (-not (Test-Path $PidFile)) {
    return $null
  }

  $serverPidText = (Get-Content -Path $PidFile -Raw).Trim()
  $serverPid = 0
  if (-not [int]::TryParse($serverPidText, [ref]$serverPid)) {
    return $null
  }

  return Get-Process -Id $serverPid -ErrorAction SilentlyContinue
}

function Get-LanUrls {
  param([int]$UrlPort)

  $urls = New-Object System.Collections.Generic.List[string]
  $urls.Add("http://127.0.0.1:$UrlPort")

  try {
    $addresses = [System.Net.Dns]::GetHostAddresses([System.Net.Dns]::GetHostName()) |
      Where-Object { $_.AddressFamily -eq [System.Net.Sockets.AddressFamily]::InterNetwork -and $_.IPAddressToString -ne "127.0.0.1" } |
      Select-Object -ExpandProperty IPAddressToString -Unique

    foreach ($address in $addresses) {
      $urls.Add("http://$address`:$UrlPort")
    }
  } catch {
    # IP discovery is best-effort; the local URL above is always available.
  }

  return $urls
}

function Show-Urls {
  param([int]$UrlPort)

  Write-Host "URLs:"
  foreach ($url in (Get-LanUrls -UrlPort $UrlPort)) {
    Write-Host "  $url"
  }
}

function Start-Server {
  $existing = Get-ServerProcess
  if ($existing) {
    $config = Get-Config
    $runningPort = if ($config -and $config.port) { [int]$config.port } else { $Port }
    Write-Host "Service is already running, PID: $($existing.Id)"
    Show-Urls -UrlPort $runningPort
    return
  }

  Ensure-RuntimeDir
  if (-not (Test-Path $WebRoot)) {
    throw "Public directory not found: $WebRoot"
  }
  if (-not (Test-Path $ServerScript)) {
    throw "Server script not found: $ServerScript"
  }

  $python = Resolve-Python
  $args = @()
  $args += $python.Args
  $args += @($ServerScript, "--host", $BindAddress, "--port", [string]$Port, "--public-dir", $WebRoot, "--data-dir", $DataDir)
  $argumentString = ($args | ForEach-Object { Quote-Arg $_ }) -join " "

  Write-Host "Starting Skill Share service..."
  Write-Host "Project directory: $ProjectRoot"
  Write-Host "Public directory: $WebRoot"
  Write-Host "Data directory: $DataDir"

  $process = Start-Process `
    -FilePath $python.FilePath `
    -ArgumentList $argumentString `
    -WorkingDirectory $ProjectRoot `
    -WindowStyle Hidden `
    -RedirectStandardOutput $OutLogFile `
    -RedirectStandardError $ErrLogFile `
    -PassThru

  Set-Content -Path $PidFile -Value $process.Id -Encoding UTF8

  $config = [pscustomobject]@{
    pid = $process.Id
    port = $Port
    bindAddress = $BindAddress
    projectRoot = $ProjectRoot
    webRoot = $WebRoot
    dataDir = $DataDir
    startedAt = (Get-Date).ToString("o")
    stdoutLog = $OutLogFile
    stderrLog = $ErrLogFile
  }
  $config | ConvertTo-Json | Set-Content -Path $ConfigFile -Encoding UTF8

  Start-Sleep -Milliseconds 900
  $running = Get-ServerProcess
  if (-not $running) {
    throw "Service failed to start. Check logs: $OutLogFile or $ErrLogFile"
  }

  Write-Host "Started, PID: $($process.Id)"
  Show-Urls -UrlPort $Port
}

function Stop-Server {
  $process = Get-ServerProcess
  if (-not $process) {
    Write-Host "Service is not running."
    if (Test-Path $PidFile) {
      Remove-Item -Path $PidFile -Force
    }
    return
  }

  Write-Host "Stopping service, PID: $($process.Id)..."
  Stop-Process -Id $process.Id -Force
  Start-Sleep -Milliseconds 300

  if (Test-Path $PidFile) {
    Remove-Item -Path $PidFile -Force
  }
  Write-Host "Stopped. Server backups are not affected."
}

function Show-Status {
  $process = Get-ServerProcess
  $config = Get-Config
  $runningPort = if ($config -and $config.port) { [int]$config.port } else { $Port }

  if ($process) {
    Write-Host "Status: running"
    Write-Host "PID: $($process.Id)"
    if ($config -and $config.startedAt) {
      Write-Host "Started at: $($config.startedAt)"
    }
    Show-Urls -UrlPort $runningPort
  } else {
    Write-Host "Status: stopped"
  }

  Write-Host "Project directory: $ProjectRoot"
  Write-Host "Public directory: $WebRoot"
  Write-Host "Data directory: $DataDir"
  Write-Host "Log directory: $RuntimeDir"
}

function Open-Site {
  $config = Get-Config
  $runningPort = if ($config -and $config.port) { [int]$config.port } else { $Port }
  $url = "http://127.0.0.1:$runningPort"
  Write-Host "Opening: $url"
  Start-Process $url
}

function Show-Logs {
  Ensure-RuntimeDir
  Write-Host "Stdout log: $OutLogFile"
  Write-Host "Stderr log: $ErrLogFile"

  foreach ($file in @($OutLogFile, $ErrLogFile)) {
    if (-not (Test-Path $file)) {
      New-Item -ItemType File -Path $file | Out-Null
    }
  }

  if ($Follow) {
    Get-Content -Path $OutLogFile, $ErrLogFile -Tail 80 -Wait
  } else {
    Get-Content -Path $OutLogFile, $ErrLogFile -Tail 80
  }
}

switch ($Action) {
  "start" { Start-Server }
  "stop" { Stop-Server }
  "restart" {
    Stop-Server
    Start-Server
  }
  "status" { Show-Status }
  "open" { Open-Site }
  "logs" { Show-Logs }
}
