<#
Purpose:
- Quick diagnostics for LAN SMB file sharing and printer sharing.
- Helps locate whether issue is network, SMB policy, service, firewall, or share visibility.

Examples:
1) Local checks only:
   PowerShell -ExecutionPolicy Bypass -File .\scripts\check-lan-share.ps1

2) Full checks against a target host:
   PowerShell -ExecutionPolicy Bypass -File .\scripts\check-lan-share.ps1 -TargetHost 192.168.1.10 -FileShare data -PrinterShare HP401
#>

[CmdletBinding()]
param(
    [string]$TargetHost,
    [string]$FileShare,
    [string]$PrinterShare,
    [string]$OutFile
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$script:Results = New-Object System.Collections.Generic.List[object]
$script:StartTs = Get-Date

function Add-Result {
    param(
        [Parameter(Mandatory = $true)][string]$Item,
        [Parameter(Mandatory = $true)][ValidateSet("PASS", "WARN", "FAIL", "INFO")][string]$Status,
        [Parameter(Mandatory = $true)][string]$Detail,
        [string]$Suggestion = ""
    )

    $script:Results.Add([PSCustomObject]@{
        Item = $Item
        Status = $Status
        Detail = $Detail
        Suggestion = $Suggestion
    })
}

function Get-RegistryDword {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Name
    )
    try {
        $value = (Get-ItemProperty -Path $Path -Name $Name -ErrorAction Stop).$Name
        return [int]$value
    } catch {
        return $null
    }
}

function Test-TcpPort {
    param(
        [Parameter(Mandatory = $true)][string]$HostName,
        [Parameter(Mandatory = $true)][int]$Port,
        [int]$TimeoutMs = 1500
    )
    $client = New-Object System.Net.Sockets.TcpClient
    try {
        $async = $client.BeginConnect($HostName, $Port, $null, $null)
        $ok = $async.AsyncWaitHandle.WaitOne($TimeoutMs, $false)
        if (-not $ok) {
            return $false
        }
        $client.EndConnect($async)
        return $true
    } catch {
        return $false
    } finally {
        $client.Close()
    }
}

function Test-LocalServices {
    $services = @(
        "LanmanWorkstation",
        "LanmanServer",
        "FDResPub",
        "fdPHost",
        "SSDPSRV",
        "upnphost",
        "Dnscache",
        "Spooler"
    )

    foreach ($svcName in $services) {
        $svc = Get-Service -Name $svcName -ErrorAction SilentlyContinue
        if (-not $svc) {
            Add-Result -Item "Service:$svcName" -Status "WARN" -Detail "Not found on this OS." -Suggestion "Skip if not applicable on current Windows edition."
            continue
        }
        if ($svc.Status -eq "Running") {
            Add-Result -Item "Service:$svcName" -Status "PASS" -Detail "Running."
        } else {
            Add-Result -Item "Service:$svcName" -Status "FAIL" -Detail "Status = $($svc.Status)." -Suggestion "Start-Service $svcName"
        }
    }
}

function Test-LocalProfilesAndFirewall {
    if (Get-Command Get-NetConnectionProfile -ErrorAction SilentlyContinue) {
        try {
            $profiles = Get-NetConnectionProfile -ErrorAction Stop
            foreach ($p in $profiles) {
                if ($p.NetworkCategory -eq "Public") {
                    Add-Result -Item "NetworkProfile:$($p.Name)" -Status "WARN" -Detail "Profile is Public." -Suggestion "Set to Private for LAN sharing."
                } else {
                    Add-Result -Item "NetworkProfile:$($p.Name)" -Status "PASS" -Detail "Profile is $($p.NetworkCategory)."
                }
            }
        } catch {
            Add-Result -Item "NetworkProfile" -Status "WARN" -Detail "Unable to read network profile: $($_.Exception.Message)"
        }
    } else {
        Add-Result -Item "NetworkProfile" -Status "INFO" -Detail "Get-NetConnectionProfile is unavailable on this OS/PowerShell."
    }

    # Fast path: check explicit rules created by fix-lan-share.ps1.
    $expectedRules = @(
        "LAN-SMB-TCP-445",
        "LAN-SMB-TCP-139",
        "LAN-NB-UDP-137",
        "LAN-NB-UDP-138"
    )

    foreach ($ruleName in $expectedRules) {
        $rule = Get-NetFirewallRule -DisplayName $ruleName -ErrorAction SilentlyContinue
        if ($rule -and $rule.Enabled -eq "True") {
            Add-Result -Item "FirewallRule:$ruleName" -Status "PASS" -Detail "Enabled."
        } else {
            Add-Result -Item "FirewallRule:$ruleName" -Status "WARN" -Detail "Not found or not enabled." -Suggestion "Run fix-lan-share.ps1 or allow SMB/NetBIOS inbound ports on Private/Domain."
        }
    }
}

function Test-LocalSmbPolicy {
    $clientRequireSig = $null
    $clientGuest = $null

    if (Get-Command Get-SmbClientConfiguration -ErrorAction SilentlyContinue) {
        try {
            $c = Get-SmbClientConfiguration
            $clientRequireSig = [bool]$c.RequireSecuritySignature
            $clientGuest = [bool]$c.EnableInsecureGuestLogons
            Add-Result -Item "SMBClient:RequireSecuritySignature" -Status "INFO" -Detail "$clientRequireSig"
            Add-Result -Item "SMBClient:EnableInsecureGuestLogons" -Status "INFO" -Detail "$clientGuest"
        } catch {
            Add-Result -Item "SMBClientConfig" -Status "WARN" -Detail "Unable to read SMB client config: $($_.Exception.Message)"
        }
    } else {
        $req = Get-RegistryDword -Path "HKLM:\SYSTEM\CurrentControlSet\Services\LanmanWorkstation\Parameters" -Name "RequireSecuritySignature"
        if ($null -ne $req) {
            Add-Result -Item "SMBClient:RequireSecuritySignature" -Status "INFO" -Detail "$req (from registry)"
            $clientRequireSig = ($req -eq 1)
        } else {
            Add-Result -Item "SMBClient:RequireSecuritySignature" -Status "INFO" -Detail "Unknown"
        }

        $guest = Get-RegistryDword -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows\LanmanWorkstation" -Name "AllowInsecureGuestAuth"
        if ($null -ne $guest) {
            Add-Result -Item "SMBClient:AllowInsecureGuestAuthPolicy" -Status "INFO" -Detail "$guest (from registry)"
            $clientGuest = ($guest -eq 1)
        }
    }

    if ($null -ne $clientRequireSig -and $null -ne $clientGuest -and $clientRequireSig -and $clientGuest) {
        Add-Result -Item "SMBClient:GuestVsSigning" -Status "WARN" -Detail "Guest access is enabled but required SMB signing is also enabled." -Suggestion "Disable RequireSecuritySignature or disable guest access."
    }

    if (Get-Command Get-SmbServerConfiguration -ErrorAction SilentlyContinue) {
        try {
            $s = Get-SmbServerConfiguration
            Add-Result -Item "SMBServer:EnableSMB1Protocol" -Status "INFO" -Detail "$($s.EnableSMB1Protocol)"
            Add-Result -Item "SMBServer:EnableSMB2Protocol" -Status "INFO" -Detail "$($s.EnableSMB2Protocol)"
            Add-Result -Item "SMBServer:RequireSecuritySignature" -Status "INFO" -Detail "$($s.RequireSecuritySignature)"
        } catch {
            Add-Result -Item "SMBServerConfig" -Status "WARN" -Detail "Unable to read SMB server config: $($_.Exception.Message)"
        }
    }

    $pn = Get-RegistryDword -Path "HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Printers\PointAndPrint" -Name "RestrictDriverInstallationToAdministrators"
    if ($null -ne $pn) {
        Add-Result -Item "PrinterPolicy:RestrictDriverInstallationToAdministrators" -Status "INFO" -Detail "$pn"
    }
}

function Test-TargetConnectivity {
    param([Parameter(Mandatory = $true)][string]$HostName)

    try {
        $pingOk = Test-Connection -ComputerName $HostName -Count 1 -Quiet -ErrorAction SilentlyContinue
        if ($pingOk) {
            Add-Result -Item "TargetPing:$HostName" -Status "PASS" -Detail "ICMP reachable."
        } else {
            Add-Result -Item "TargetPing:$HostName" -Status "WARN" -Detail "ICMP not reachable (could still be normal if ICMP blocked)."
        }
    } catch {
        Add-Result -Item "TargetPing:$HostName" -Status "WARN" -Detail "Ping test error: $($_.Exception.Message)"
    }

    foreach ($p in @(445, 139)) {
        $ok = Test-TcpPort -HostName $HostName -Port $p
        if ($ok) {
            Add-Result -Item "TargetPort:${HostName}:$p" -Status "PASS" -Detail "TCP $p open."
        } else {
            Add-Result -Item "TargetPort:${HostName}:$p" -Status "FAIL" -Detail "TCP $p unreachable." -Suggestion "Check target firewall, service, and network path."
        }
    }

    cmd /c "net view \\$HostName >nul 2>&1"
    if ($LASTEXITCODE -eq 0) {
        Add-Result -Item "TargetSMBEnum:$HostName" -Status "PASS" -Detail "SMB share enumeration succeeded."
    } else {
        Add-Result -Item "TargetSMBEnum:$HostName" -Status "WARN" -Detail "SMB share enumeration failed (code $LASTEXITCODE)." -Suggestion "Check credentials, SMB signing policy, and guest settings."
    }
}

function Test-FileSharePath {
    param(
        [Parameter(Mandatory = $true)][string]$HostName,
        [Parameter(Mandatory = $true)][string]$ShareName
    )
    $path = "\\$HostName\$ShareName"
    cmd /c "dir $path >nul 2>&1"
    if ($LASTEXITCODE -eq 0) {
        Add-Result -Item "FileShare:$path" -Status "PASS" -Detail "Path is accessible."
    } else {
        Add-Result -Item "FileShare:$path" -Status "FAIL" -Detail "Path is not accessible (code $LASTEXITCODE)." -Suggestion "Validate share name, permissions, and authentication."
    }
}

function Test-PrinterShare {
    param(
        [Parameter(Mandatory = $true)][string]$HostName,
        [Parameter(Mandatory = $true)][string]$ShareName
    )

    try {
        $shares = Get-WmiObject -Class Win32_Share -ComputerName $HostName -ErrorAction Stop
        $hit = $shares | Where-Object { $_.Name -ieq $ShareName -and $_.Type -eq 1 }
        if ($hit) {
            Add-Result -Item "PrinterShare:\\$HostName\$ShareName" -Status "PASS" -Detail "Printer share exists on target."
        } else {
            Add-Result -Item "PrinterShare:\\$HostName\$ShareName" -Status "FAIL" -Detail "Printer share not found via Win32_Share." -Suggestion "Check printer sharing name and spooler state on target."
        }
    } catch {
        Add-Result -Item "PrinterShare:\\$HostName\$ShareName" -Status "WARN" -Detail "Unable to query remote shares: $($_.Exception.Message)" -Suggestion "Verify RPC/WMI access and firewall rules on target."
    }
}

function Show-Summary {
    $pass = @($script:Results | Where-Object { $_.Status -eq "PASS" }).Count
    $warn = @($script:Results | Where-Object { $_.Status -eq "WARN" }).Count
    $fail = @($script:Results | Where-Object { $_.Status -eq "FAIL" }).Count
    $info = @($script:Results | Where-Object { $_.Status -eq "INFO" }).Count

    Write-Host ""
    Write-Host "========== LAN SHARE CHECK SUMMARY =========="
    Write-Host ("PASS: {0}  WARN: {1}  FAIL: {2}  INFO: {3}" -f $pass, $warn, $fail, $info)
    Write-Host "---------------------------------------------"
    $script:Results | Format-Table -AutoSize

    if ($OutFile) {
        $dir = Split-Path -Parent $OutFile
        if ($dir -and -not (Test-Path $dir)) {
            New-Item -ItemType Directory -Path $dir -Force | Out-Null
        }
        $script:Results | Export-Csv -Path $OutFile -NoTypeInformation -Encoding UTF8
        Write-Host ""
        Write-Host ("Report saved: {0}" -f $OutFile)
    }

    Write-Host ""
    Write-Host "Runtime: $((Get-Date) - $script:StartTs)"
    Write-Host "============================================"
}

try {
    Add-Result -Item "HostTime" -Status "INFO" -Detail (Get-Date -Format "yyyy-MM-dd HH:mm:ss")
    Add-Result -Item "ComputerName" -Status "INFO" -Detail $env:COMPUTERNAME

    Test-LocalServices
    Test-LocalProfilesAndFirewall
    Test-LocalSmbPolicy

    if ($TargetHost) {
        Test-TargetConnectivity -HostName $TargetHost
        if ($FileShare) {
            Test-FileSharePath -HostName $TargetHost -ShareName $FileShare
        }
        if ($PrinterShare) {
            Test-PrinterShare -HostName $TargetHost -ShareName $PrinterShare
        }
    } else {
        Add-Result -Item "TargetHost" -Status "INFO" -Detail "Not provided. Skipped remote checks."
    }

    Show-Summary
} catch {
    Add-Result -Item "ScriptError" -Status "FAIL" -Detail $_.Exception.Message
    Show-Summary
    throw
}
