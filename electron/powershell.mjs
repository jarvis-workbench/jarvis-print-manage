import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)
const DEFAULT_TIMEOUT_MS = 20_000
const DEFAULT_MAX_BUFFER = 20 * 1024 * 1024

function uniq(values) {
  return [...new Set(values.filter(Boolean))]
}

function resolvePowerShellCandidates() {
  const winDir = process.env.WINDIR || process.env.windir || 'C:\\Windows'
  return uniq([
    path.join(winDir, 'System32', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    path.join(winDir, 'Sysnative', 'WindowsPowerShell', 'v1.0', 'powershell.exe'),
    'powershell.exe',
    'pwsh.exe',
  ])
}

function wrapScript(script) {
  return `
    $__codexUtf8NoBom = New-Object System.Text.UTF8Encoding $false
    [Console]::InputEncoding = $__codexUtf8NoBom
    [Console]::OutputEncoding = $__codexUtf8NoBom
    $OutputEncoding = $__codexUtf8NoBom

    function __codex_has_command {
      param([string]$Name)
      return [bool](Get-Command $Name -ErrorAction SilentlyContinue)
    }

    if (-not (__codex_has_command 'ConvertTo-Json')) {
      try { Add-Type -AssemblyName 'System.Web.Extensions' -ErrorAction SilentlyContinue } catch {}
      function global:ConvertTo-Json {
        [CmdletBinding()]
        param(
          [Parameter(ValueFromPipeline = $true)] $InputObject,
          [int] $Depth = 10,
          [switch] $Compress
        )
        begin {
          $items = @()
        }
        process {
          $items += ,$InputObject
        }
        end {
          $target = if ($items.Count -eq 1) { $items[0] } else { $items }
          $serializer = New-Object System.Web.Script.Serialization.JavaScriptSerializer
          $serializer.MaxJsonLength = 67108864
          $serializer.RecursionLimit = [Math]::Max($Depth * 4, 16)
          $serializer.Serialize($target)
        }
      }
    }

    if (-not (__codex_has_command 'Get-CimInstance')) {
      function global:Get-CimInstance {
        [CmdletBinding()]
        param(
          [Parameter(Mandatory = $true)][string] $ClassName,
          [string] $Filter,
          [string] $Namespace = 'root\\cimv2'
        )
        if ($Filter) {
          return Get-WmiObject -Class $ClassName -Namespace $Namespace -Filter $Filter -ErrorAction SilentlyContinue
        }
        return Get-WmiObject -Class $ClassName -Namespace $Namespace -ErrorAction SilentlyContinue
      }
    }

    function __codex_find_print_admin_script {
      param([string]$ScriptName)
      $winDir = $env:WINDIR
      if (-not $winDir) { $winDir = $env:windir }
      if (-not $winDir) { $winDir = 'C:\\Windows' }
      $base = Join-Path $winDir 'System32\\Printing_Admin_Scripts'
      if (-not (Test-Path -LiteralPath $base)) { return '' }
      $preferred = @('zh-CN', 'en-US')
      foreach ($lang in $preferred) {
        $candidate = Join-Path $base (Join-Path $lang $ScriptName)
        if (Test-Path -LiteralPath $candidate) { return $candidate }
      }
      foreach ($dir in (Get-ChildItem -Path $base -Directory -ErrorAction SilentlyContinue)) {
        $candidate = Join-Path $dir.FullName $ScriptName
        if (Test-Path -LiteralPath $candidate) { return $candidate }
      }
      return ''
    }

    $__codexPnpUtilCommand = Get-Command pnputil.exe -ErrorAction SilentlyContinue
    $__codexPnpUtilPath = if ($__codexPnpUtilCommand) { $__codexPnpUtilCommand.Source } else { 'pnputil.exe' }
    $__codexPnpUtilHelp = ''
    try {
      $__codexPnpUtilHelp = (& $__codexPnpUtilPath '/?' 2>&1 | Out-String)
    } catch {
      $__codexPnpUtilHelp = ''
    }
    $__codexPnpUtilSupportsModern = $__codexPnpUtilHelp -match '(?i)(/add-driver|/enum-drivers|/delete-driver)'

    function global:pnputil.exe {
      [CmdletBinding()]
      param(
        [Parameter(ValueFromRemainingArguments = $true)]
        [string[]] $Args
      )
      if (-not $Args) {
        $output = (& $__codexPnpUtilPath 2>&1 | Out-String)
        $global:LASTEXITCODE = $LASTEXITCODE
        $output
        return
      }

      if ($__codexPnpUtilSupportsModern) {
        $output = (& $__codexPnpUtilPath @Args 2>&1 | Out-String)
        $global:LASTEXITCODE = $LASTEXITCODE
        $output
        return
      }

      $argsLower = @($Args | ForEach-Object { [string]$_.ToLowerInvariant() })
      $contains = {
        param([string]$flag)
        return ($argsLower -contains $flag.ToLowerInvariant())
      }

      if (& $contains '/enum-drivers') {
        $output = (& $__codexPnpUtilPath '-e' 2>&1 | Out-String)
        $global:LASTEXITCODE = $LASTEXITCODE
        $output
        return
      }

      if (& $contains '/delete-driver') {
        $index = [Array]::IndexOf($argsLower, '/delete-driver')
        $oemInf = ''
        if ($index -ge 0 -and $index + 1 -lt $Args.Count) {
          $oemInf = [string]$Args[$index + 1]
        }
        if (-not $oemInf) {
          $global:LASTEXITCODE = 1
          'Legacy pnputil mode: missing oem inf for /delete-driver.'
          return
        }
        $legacyArgs = @('-d', $oemInf)
        if ((& $contains '/force') -or (& $contains '/uninstall')) {
          $legacyArgs = @('-f') + $legacyArgs
        }
        $output = (& $__codexPnpUtilPath @legacyArgs 2>&1 | Out-String)
        $global:LASTEXITCODE = $LASTEXITCODE
        $output
        return
      }

      if (& $contains '/add-driver') {
        $index = [Array]::IndexOf($argsLower, '/add-driver')
        $inputPath = ''
        if ($index -ge 0 -and $index + 1 -lt $Args.Count) {
          $inputPath = [string]$Args[$index + 1]
        }
        if (-not $inputPath) {
          $global:LASTEXITCODE = 1
          'Legacy pnputil mode: missing inf path for /add-driver.'
          return
        }

        $install = (& $contains '/install')
        $subdirs = (& $contains '/subdirs')
        $files = @()

        try {
          if ($inputPath.Contains('*')) {
            $files = @(Get-ChildItem -Path $inputPath -File -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
          } elseif ($subdirs -and (Test-Path -LiteralPath $inputPath) -and (Get-Item -LiteralPath $inputPath).PSIsContainer) {
            $files = @(Get-ChildItem -Path $inputPath -Filter *.inf -File -Recurse -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
          } elseif ((Test-Path -LiteralPath $inputPath) -and (Get-Item -LiteralPath $inputPath).PSIsContainer) {
            $files = @(Get-ChildItem -Path $inputPath -Filter *.inf -File -ErrorAction SilentlyContinue | Select-Object -ExpandProperty FullName)
          } else {
            $files = @($inputPath)
          }
        } catch {
          $files = @($inputPath)
        }

        if (-not $files -or $files.Count -eq 0) {
          $global:LASTEXITCODE = 1
          "Legacy pnputil mode: no inf files resolved for path '$inputPath'."
          return
        }

        $combined = @()
        $failed = $false
        foreach ($inf in ($files | Select-Object -Unique)) {
          $legacyArgs = if ($install) { @('-i', '-a', $inf) } else { @('-a', $inf) }
          $part = (& $__codexPnpUtilPath @legacyArgs 2>&1 | Out-String)
          if ($LASTEXITCODE -ne 0) {
            $failed = $true
          }
          $combined += $part
        }

        $global:LASTEXITCODE = if ($failed) { 1 } else { 0 }
        ($combined -join [Environment]::NewLine)
        return
      }

      if (& $contains '/export-driver') {
        $global:LASTEXITCODE = 1
        'Legacy pnputil mode: /export-driver is not supported on this Windows version.'
        return
      }

      $passthrough = (& $__codexPnpUtilPath @Args 2>&1 | Out-String)
      $global:LASTEXITCODE = $LASTEXITCODE
      $passthrough
    }

    if (-not (__codex_has_command 'Get-PnpDevice')) {
      function global:Get-PnpDevice {
        [CmdletBinding()]
        param(
          [switch] $PresentOnly
        )
        @()
      }
    }

    if (-not (__codex_has_command 'Get-Printer')) {
      function global:Get-Printer {
        [CmdletBinding()]
        param(
          [string] $Name
        )
        $items = @()
        if ($Name) {
          $escaped = $Name.Replace("'", "''")
          $items = @(Get-WmiObject -Class Win32_Printer -Filter ("Name = '{0}'" -f $escaped) -ErrorAction SilentlyContinue)
        } else {
          $items = @(Get-WmiObject -Class Win32_Printer -ErrorAction SilentlyContinue)
        }
        foreach ($p in $items) {
          [PSCustomObject]@{
            Name = [string]$p.Name
            DriverName = [string]$p.DriverName
            PortName = [string]$p.PortName
            Shared = [bool]$p.Shared
            ShareName = [string]$p.ShareName
            PrinterStatus = $p.PrinterStatus
            WorkOffline = [bool]$p.WorkOffline
            QueueStatus = $p.ExtendedPrinterStatus
          }
        }
      }
    }

    if (-not (__codex_has_command 'Get-PrinterDriver')) {
      function global:Get-PrinterDriver {
        [CmdletBinding()]
        param(
          [string] $Name
        )
        $items = @()
        if ($Name) {
          $escaped = $Name.Replace("'", "''")
          $items = @(Get-WmiObject -Class Win32_PrinterDriver -Filter ("Name = '{0}'" -f $escaped) -ErrorAction SilentlyContinue)
        } else {
          $items = @(Get-WmiObject -Class Win32_PrinterDriver -ErrorAction SilentlyContinue)
        }
        foreach ($d in $items) {
          $infPath = [string]$d.InfName
          if ($infPath -and -not ($infPath -match '(?i)^[a-z]:\\\\')) {
            $infCandidate = Join-Path $env:WINDIR (Join-Path 'INF' $infPath)
            if (Test-Path -LiteralPath $infCandidate) {
              $infPath = $infCandidate
            }
          }
          [PSCustomObject]@{
            Name = [string]$d.Name
            Manufacturer = [string]$d.Manufacturer
            MajorVersion = [int]($d.MajorVersion)
            DriverVersion = if ($d.DriverVersion) { [string]$d.DriverVersion } else { [string]$d.Version }
            InfPath = $infPath
            PrinterEnvironment = [string]$d.SupportedPlatform
            ConfigFile = [string]$d.ConfigFile
            DataFile = [string]$d.DataFile
            DriverPath = [string]$d.DriverPath
            HelpFile = [string]$d.HelpFile
            DependentFiles = @($d.DependentFiles)
          }
        }
      }
    }

    if (-not (__codex_has_command 'Get-PrinterPort')) {
      function global:Get-PrinterPort {
        [CmdletBinding()]
        param(
          [string] $Name
        )
        $ports = @()
        $tcpPorts = @(Get-WmiObject -Class Win32_TCPIPPrinterPort -ErrorAction SilentlyContinue)
        foreach ($p in $tcpPorts) {
          $ports += [PSCustomObject]@{
            Name = [string]$p.Name
            PrinterHostAddress = [string]$p.HostAddress
            PortNumber = [string]$p.PortNumber
          }
        }
        $printerPorts = @(Get-WmiObject -Class Win32_Printer -ErrorAction SilentlyContinue | Select-Object -ExpandProperty PortName -Unique)
        foreach ($nameItem in $printerPorts) {
          if (-not $nameItem) { continue }
          $exists = $false
          foreach ($existing in $ports) {
            if ($existing.Name -eq $nameItem) {
              $exists = $true
              break
            }
          }
          if (-not $exists) {
            $ports += [PSCustomObject]@{
              Name = [string]$nameItem
              PrinterHostAddress = ''
              PortNumber = ''
            }
          }
        }
        if ($Name) {
          return @($ports | Where-Object { $_.Name -eq $Name })
        }
        return $ports
      }
    }

    if (-not (__codex_has_command 'Add-PrinterPort')) {
      function global:Add-PrinterPort {
        [CmdletBinding()]
        param(
          [Parameter(Mandatory = $true)][string] $Name,
          [Parameter(Mandatory = $true)][string] $PrinterHostAddress
        )
        $scriptPath = __codex_find_print_admin_script -ScriptName 'prnport.vbs'
        if (-not $scriptPath) {
          throw "prnport.vbs not found. Cannot add printer port on this system."
        }
        & cscript.exe //NoLogo $scriptPath -a -r $Name -h $PrinterHostAddress -o raw -n 9100 | Out-Null
        if ($LASTEXITCODE -ne 0) {
          throw "Failed to add printer port: $Name => $PrinterHostAddress"
        }
      }
    }

    if (-not (__codex_has_command 'Remove-PrinterPort')) {
      function global:Remove-PrinterPort {
        [CmdletBinding()]
        param(
          [Parameter(Mandatory = $true)][string] $Name
        )
        $scriptPath = __codex_find_print_admin_script -ScriptName 'prnport.vbs'
        if (-not $scriptPath) {
          throw "prnport.vbs not found. Cannot remove printer port on this system."
        }
        & cscript.exe //NoLogo $scriptPath -d -r $Name | Out-Null
        if ($LASTEXITCODE -ne 0) {
          throw "Failed to remove printer port: $Name"
        }
      }
    }

    if (-not (__codex_has_command 'Add-PrinterDriver')) {
      function global:Add-PrinterDriver {
        [CmdletBinding()]
        param(
          [Parameter(Mandatory = $true)][string] $Name,
          [Parameter(Mandatory = $true)][string] $InfPath
        )
        & rundll32.exe printui.dll,PrintUIEntry /ia /m $Name /f $InfPath /q | Out-Null
        Start-Sleep -Milliseconds 800
      }
    }

    if (-not (__codex_has_command 'Add-Printer')) {
      function global:Add-Printer {
        [CmdletBinding()]
        param(
          [Parameter(Mandatory = $true)][string] $Name,
          [Parameter(Mandatory = $true)][string] $DriverName,
          [Parameter(Mandatory = $true)][string] $PortName
        )
        & rundll32.exe printui.dll,PrintUIEntry /if /b $Name /m $DriverName /r $PortName /q | Out-Null
        Start-Sleep -Milliseconds 800
      }
    }

    if (-not (__codex_has_command 'Remove-Printer')) {
      function global:Remove-Printer {
        [CmdletBinding()]
        param(
          [Parameter(Mandatory = $true)][string] $Name
        )
        & rundll32.exe printui.dll,PrintUIEntry /dl /n $Name /q | Out-Null
        Start-Sleep -Milliseconds 600
      }
    }

    if (-not (__codex_has_command 'Remove-PrinterDriver')) {
      function global:Remove-PrinterDriver {
        [CmdletBinding()]
        param(
          [Parameter(Mandatory = $true)][string] $Name
        )
        & rundll32.exe printui.dll,PrintUIEntry /dd /m $Name /q | Out-Null
        Start-Sleep -Milliseconds 600
      }
    }

    ${script}
  `
}

function buildPowerShellArgs(script) {
  return ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-Command', wrapScript(script)]
}

function toErrorMessage(stderr, stdout, fallback = '') {
  return String(stderr || stdout || fallback || '').trim()
}

async function execWithCandidates(script, options = {}) {
  const args = buildPowerShellArgs(script)
  const timeoutMs = Math.max(Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS, 1_000)
  const candidates = resolvePowerShellCandidates()
  let lastError = null

  for (const executable of candidates) {
    try {
      const result = await execFileAsync(executable, args, {
        windowsHide: true,
        maxBuffer: DEFAULT_MAX_BUFFER,
        timeout: timeoutMs,
      })
      return {
        stdout: String(result?.stdout || '').trim(),
        stderr: String(result?.stderr || '').trim(),
      }
    } catch (error) {
      const message = String(error?.message || '')
      const isNotFound = error?.code === 'ENOENT' || message.includes('ENOENT')
      if (isNotFound) {
        lastError = error
        continue
      }
      if (error?.killed && error?.signal === 'SIGTERM') {
        throw new Error(`PowerShell execution timed out after ${timeoutMs}ms.`)
      }
      const stderr = String(error?.stderr || '')
      const stdout = String(error?.stdout || '')
      throw new Error(toErrorMessage(stderr, stdout, message))
    }
  }

  throw new Error(`PowerShell executable not found. Tried: ${candidates.join(', ')}. ${lastError?.message || ''}`.trim())
}

export async function runPowerShell(script, options = {}) {
  return execWithCandidates(script, options)
}

export async function runPowerShellJson(script, options = {}) {
  const wrappedJsonScript = `
    $ErrorActionPreference = 'Stop'
    $ProgressPreference = 'SilentlyContinue'
    $__codexResult = & {
      ${script}
    }
    if ($null -eq $__codexResult) {
      $__codexJson = 'null'
    } elseif ($__codexResult -is [string]) {
      $__codexJson = $__codexResult
    } else {
      $__codexJson = $__codexResult | ConvertTo-Json -Depth 12 -Compress
    }
    if ($null -eq $__codexJson -or $__codexJson -eq '') {
      $__codexJson = 'null'
    }
    [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($__codexJson))
  `

  const { stdout, stderr } = await runPowerShell(wrappedJsonScript, options)
  const base64Text = stdout.trim().split(/\r?\n/).filter(Boolean).pop() || ''
  const jsonText = Buffer.from(base64Text, 'base64').toString('utf8').trim()
  if (!jsonText) {
    throw new Error(toErrorMessage(stderr, stdout, 'PowerShell returned empty output.'))
  }

  try {
    return JSON.parse(jsonText)
  } catch {
    throw new Error(toErrorMessage(stderr, stdout, `Failed to parse PowerShell JSON output: ${jsonText}`))
  }
}
