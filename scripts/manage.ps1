param(
  [ValidateSet("start", "stop", "restart", "status", "open", "logs")]
  [string]$Action = "status",

  [string]$BindAddress = "0.0.0.0",

  [ValidateRange(1, 65535)]
  [int]$Port = 5173,

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

  throw "未找到 Python。请先安装 Python 3，并确认 python 或 py 命令可用。"
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

  Write-Host "访问地址："
  foreach ($url in (Get-LanUrls -UrlPort $UrlPort)) {
    Write-Host "  $url"
  }
}

function Start-Server {
  $existing = Get-ServerProcess
  if ($existing) {
    $config = Get-Config
    $runningPort = if ($config -and $config.port) { [int]$config.port } else { $Port }
    Write-Host "服务已经在运行，PID: $($existing.Id)"
    Show-Urls -UrlPort $runningPort
    return
  }

  Ensure-RuntimeDir
  if (-not (Test-Path $WebRoot)) {
    throw "未找到网页目录：$WebRoot"
  }
  if (-not (Test-Path $ServerScript)) {
    throw "未找到共享服务脚本：$ServerScript"
  }

  $python = Resolve-Python
  $args = @()
  $args += $python.Args
  $args += @($ServerScript, "--host", $BindAddress, "--port", [string]$Port, "--public-dir", $WebRoot, "--data-dir", $DataDir)
  $argumentString = ($args | ForEach-Object { Quote-Arg $_ }) -join " "

  Write-Host "正在启动 Skill 共享站..."
  Write-Host "项目目录：$ProjectRoot"
  Write-Host "网页目录：$WebRoot"
  Write-Host "数据目录：$DataDir"

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
    throw "服务启动失败。请查看日志：$OutLogFile 或 $ErrLogFile"
  }

  Write-Host "启动成功，PID: $($process.Id)"
  Show-Urls -UrlPort $Port
}

function Stop-Server {
  $process = Get-ServerProcess
  if (-not $process) {
    Write-Host "服务没有运行。"
    if (Test-Path $PidFile) {
      Remove-Item -Path $PidFile -Force
    }
    return
  }

  Write-Host "正在停止服务，PID: $($process.Id)..."
  Stop-Process -Id $process.Id -Force
  Start-Sleep -Milliseconds 300

  if (Test-Path $PidFile) {
    Remove-Item -Path $PidFile -Force
  }
  Write-Host "已停止。服务端备份文件不受影响。"
}

function Show-Status {
  $process = Get-ServerProcess
  $config = Get-Config
  $runningPort = if ($config -and $config.port) { [int]$config.port } else { $Port }

  if ($process) {
    Write-Host "状态：运行中"
    Write-Host "PID：$($process.Id)"
    if ($config -and $config.startedAt) {
      Write-Host "启动时间：$($config.startedAt)"
    }
    Show-Urls -UrlPort $runningPort
  } else {
    Write-Host "状态：未运行"
  }

  Write-Host "运行目录：$ProjectRoot"
  Write-Host "网页目录：$WebRoot"
  Write-Host "数据目录：$DataDir"
  Write-Host "日志目录：$RuntimeDir"
}

function Open-Site {
  $config = Get-Config
  $runningPort = if ($config -and $config.port) { [int]$config.port } else { $Port }
  $url = "http://127.0.0.1:$runningPort"
  Write-Host "打开：$url"
  Start-Process $url
}

function Show-Logs {
  Ensure-RuntimeDir
  Write-Host "标准输出日志：$OutLogFile"
  Write-Host "错误日志：$ErrLogFile"

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

