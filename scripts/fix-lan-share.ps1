<#
Purpose:
- One-click repair for LAN SMB file sharing and printer sharing issues.
- Default mode is security-first.
- Compatibility mode is available for legacy NAS/printer environments.

Examples:
1) Safe mode (recommended):
   PowerShell -ExecutionPolicy Bypass -File .\scripts\fix-lan-share.ps1

2) Compatibility mode (legacy devices):
   PowerShell -ExecutionPolicy Bypass -File .\scripts\fix-lan-share.ps1 -Mode Compatibility -EnableSMB1Legacy -FixPrinterLegacy

3) Mixed auth mode (allow passwordless guest shares + keep password prompt for protected shares):
   PowerShell -ExecutionPolicy Bypass -File .\scripts\fix-lan-share.ps1 -MixedAuth
#>

[CmdletBinding()]
param(
    [ValidateSet("Safe", "Compatibility")]
    [string]$Mode = "Safe",

    [switch]$EnableSMB1Legacy,
    [switch]$FixPrinterLegacy,
    [switch]$MixedAuth
)

Set-StrictMode -Version 2.0
$ErrorActionPreference = "Stop"

$script:RebootRequired = $false
$script:LogPath = Join-Path $env:TEMP ("lan-share-fix-" + (Get-Date -Format "yyyyMMdd-HHmmss") + ".log")

function Write-Log {
    param(
        [Parameter(Mandatory = $true)][string]$Message,
        [ValidateSet("INFO", "WARN", "ERROR")][string]$Level = "INFO"
    )
    $line = "[{0}] [{1}] {2}" -f (Get-Date -Format "yyyy-MM-dd HH:mm:ss"), $Level, $Message
    Write-Host $line
    Add-Content -Path $script:LogPath -Value $line
}

function Assert-Admin {
    $current = [Security.Principal.WindowsIdentity]::GetCurrent()
    $principal = New-Object Security.Principal.WindowsPrincipal($current)
    if (-not $principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) {
        throw "Please run this script in an elevated PowerShell window (Run as Administrator)."
    }
}

function Get-OsInfo {
    $os = Get-WmiObject -Class Win32_OperatingSystem
    $version = [Version]$os.Version
    return @{
        Caption = $os.Caption
        Version = $version
        IsWin7 = ($version.Major -eq 6 -and $version.Minor -eq 1)
        IsWin10OrLater = ($version.Major -ge 10)
    }
}

function Set-ServiceSafe {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [ValidateSet("Automatic", "Manual", "Disabled")][string]$StartupType = "Automatic",
        [switch]$SkipStartupType,
        [switch]$StartNow
    )

    $svc = Get-Service -Name $Name -ErrorAction SilentlyContinue
    if (-not $svc) {
        Write-Log "Service not found, skipping: $Name" "WARN"
        return
    }

    if (-not $SkipStartupType) {
        try {
            Set-Service -Name $Name -StartupType $StartupType
        } catch {
            Write-Log "Failed to set startup type for ${Name}: $($_.Exception.Message)" "WARN"
        }
    }

    if ($StartNow) {
        try {
            if ((Get-Service -Name $Name).Status -ne "Running") {
                Start-Service -Name $Name
            }
        } catch {
            Write-Log "Failed to start service ${Name}: $($_.Exception.Message)" "WARN"
        }
    }
}

function Set-RegistryDword {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][int]$Value
    )

    if (-not (Test-Path $Path)) {
        New-Item -Path $Path -Force | Out-Null
    }
    New-ItemProperty -Path $Path -Name $Name -PropertyType DWord -Value $Value -Force | Out-Null
    Write-Log "Registry set: $Path\$Name = $Value"
}

function Ensure-FirewallRules {
    # Avoid localization issues by creating explicit port rules.
    $rules = @(
        @{ Name = "LAN-SMB-TCP-445"; Protocol = "TCP"; Port = "445" },
        @{ Name = "LAN-SMB-TCP-139"; Protocol = "TCP"; Port = "139" },
        @{ Name = "LAN-NB-UDP-137"; Protocol = "UDP"; Port = "137" },
        @{ Name = "LAN-NB-UDP-138"; Protocol = "UDP"; Port = "138" }
    )

    foreach ($r in $rules) {
        cmd /c "netsh advfirewall firewall delete rule name=`"$($r.Name)`"" | Out-Null
        cmd /c "netsh advfirewall firewall add rule name=`"$($r.Name)`" dir=in action=allow protocol=$($r.Protocol) localport=$($r.Port) profile=private,domain" | Out-Null
        Write-Log "Firewall rule applied: $($r.Name)"
    }
}

function Try-SetPrivateNetworkProfile {
    if (Get-Command Set-NetConnectionProfile -ErrorAction SilentlyContinue) {
        try {
            $profiles = Get-NetConnectionProfile -ErrorAction Stop
            foreach ($p in $profiles) {
                if ($p.NetworkCategory -eq "Public") {
                    Set-NetConnectionProfile -InterfaceIndex $p.InterfaceIndex -NetworkCategory Private -ErrorAction Stop
                    Write-Log "Network profile changed to Private: $($p.Name)"
                }
            }
            return
        } catch {
            Write-Log "Failed to change network profile automatically: $($_.Exception.Message)" "WARN"
        }
    }
    Write-Log "Please ensure current network is set to Private manually." "WARN"
}

function Configure-DiscoveryAndSharing {
    Write-Log "Configuring discovery and sharing services..."
    Set-ServiceSafe -Name "LanmanWorkstation" -StartupType Automatic -StartNow
    Set-ServiceSafe -Name "LanmanServer" -StartupType Automatic -StartNow
    Set-ServiceSafe -Name "FDResPub" -StartupType Automatic -StartNow
    Set-ServiceSafe -Name "fdPHost" -StartupType Automatic -StartNow
    Set-ServiceSafe -Name "SSDPSRV" -StartupType Automatic -StartNow
    Set-ServiceSafe -Name "upnphost" -StartupType Automatic -StartNow
    # DNS Client startup type can be protected on modern Windows.
    Set-ServiceSafe -Name "Dnscache" -SkipStartupType -StartNow
    Set-ServiceSafe -Name "Spooler" -StartupType Automatic -StartNow

    Ensure-FirewallRules
    Try-SetPrivateNetworkProfile
}

function Configure-SmbPolicy {
    param([hashtable]$OsInfo)

    Write-Log "Configuring SMB policy. Mode = $Mode"

    $serverPath = "HKLM:\SYSTEM\CurrentControlSet\Services\LanmanServer\Parameters"
    $clientPath = "HKLM:\SYSTEM\CurrentControlSet\Services\LanmanWorkstation\Parameters"
    $guestPolicyPath = "HKLM:\SOFTWARE\Policies\Microsoft\Windows\LanmanWorkstation"

    if ($MixedAuth) {
        # MixedAuth is for environments that need BOTH:
        # - direct access to passwordless guest shares
        # - credential prompt on protected shares
        # Guest auth and required signing cannot be true at the same time.
        Set-RegistryDword -Path $serverPath -Name "RequireSecuritySignature" -Value 0
        Set-RegistryDword -Path $clientPath -Name "RequireSecuritySignature" -Value 0
        Set-RegistryDword -Path $guestPolicyPath -Name "AllowInsecureGuestAuth" -Value 1
        Write-Log "MixedAuth enabled: guest access allowed and SMB signing requirement relaxed." "WARN"
    } elseif ($Mode -eq "Safe") {
        Set-RegistryDword -Path $serverPath -Name "RequireSecuritySignature" -Value 1
        Set-RegistryDword -Path $clientPath -Name "RequireSecuritySignature" -Value 1
        Set-RegistryDword -Path $guestPolicyPath -Name "AllowInsecureGuestAuth" -Value 0
    } else {
        Set-RegistryDword -Path $serverPath -Name "RequireSecuritySignature" -Value 0
        Set-RegistryDword -Path $clientPath -Name "RequireSecuritySignature" -Value 0
        Set-RegistryDword -Path $guestPolicyPath -Name "AllowInsecureGuestAuth" -Value 1
        Write-Log "Compatibility mode enabled insecure SMB guest access and relaxed signature requirements." "WARN"
    }

    if ($OsInfo.IsWin10OrLater -and (Get-Command Set-SmbClientConfiguration -ErrorAction SilentlyContinue)) {
        try {
            if ($MixedAuth -or $Mode -eq "Compatibility") {
                Set-SmbClientConfiguration -EnableInsecureGuestLogons $true -RequireSecuritySignature $false -Force | Out-Null
                Write-Log "Applied SMB client runtime config for guest + unsigned fallback." "WARN"
            } else {
                Set-SmbClientConfiguration -EnableInsecureGuestLogons $false -RequireSecuritySignature $true -Force | Out-Null
                Write-Log "Applied SMB client runtime config for safe mode."
            }
        } catch {
            Write-Log "Failed to apply SMB client runtime config: $($_.Exception.Message)" "WARN"
        }
    }

    if ($EnableSMB1Legacy) {
        Write-Log "Attempting to enable SMB1 for legacy compatibility (high risk)." "WARN"
        if ($OsInfo.IsWin10OrLater) {
            try {
                if (Get-Command Enable-WindowsOptionalFeature -ErrorAction SilentlyContinue) {
                    Enable-WindowsOptionalFeature -Online -FeatureName SMB1Protocol -All -NoRestart | Out-Null
                } else {
                    cmd /c "dism /online /enable-feature /featurename:SMB1Protocol /all /norestart" | Out-Null
                }
                $script:RebootRequired = $true
                Write-Log "SMB1 feature enable requested. Reboot is recommended." "WARN"
            } catch {
                Write-Log "Failed to enable SMB1: $($_.Exception.Message)" "ERROR"
            }
        } else {
            Write-Log "Automatic SMB1 feature enable is not supported on this OS version." "WARN"
        }
    } elseif ($OsInfo.IsWin10OrLater -and $Mode -eq "Safe") {
        try {
            if (Get-Command Disable-WindowsOptionalFeature -ErrorAction SilentlyContinue) {
                Disable-WindowsOptionalFeature -Online -FeatureName SMB1Protocol -NoRestart | Out-Null
            } else {
                cmd /c "dism /online /disable-feature /featurename:SMB1Protocol /norestart" | Out-Null
            }
            $script:RebootRequired = $true
            Write-Log "SMB1 disable requested (safe mode). Reboot is recommended."
        } catch {
            Write-Log "Failed to disable SMB1 (non-fatal): $($_.Exception.Message)" "WARN"
        }
    }
}

function Refresh-SmbClientState {
    Write-Log "Refreshing SMB client session state..."
    try {
        cmd /c "net use * /delete /y" | Out-Null
    } catch {
        Write-Log "Failed to clear SMB sessions (non-fatal): $($_.Exception.Message)" "WARN"
    }

    try {
        if (Get-Command Restart-Service -ErrorAction SilentlyContinue) {
            Restart-Service -Name LanmanWorkstation -Force -ErrorAction Stop
        } else {
            cmd /c "sc stop lanmanworkstation >nul 2>&1 & sc start lanmanworkstation >nul 2>&1"
        }
        Write-Log "SMB client service restarted."
    } catch {
        Write-Log "Failed to restart LanmanWorkstation (non-fatal): $($_.Exception.Message)" "WARN"
    }
}

function Configure-PrinterPolicy {
    Write-Log "Configuring printer sharing policy..."
    Set-ServiceSafe -Name "Spooler" -StartupType Automatic -StartNow

    $pointAndPrintPath = "HKLM:\SOFTWARE\Policies\Microsoft\Windows NT\Printers\PointAndPrint"
    if ($Mode -eq "Safe") {
        Set-RegistryDword -Path $pointAndPrintPath -Name "RestrictDriverInstallationToAdministrators" -Value 1
    } else {
        Set-RegistryDword -Path $pointAndPrintPath -Name "RestrictDriverInstallationToAdministrators" -Value 0
        Write-Log "Compatibility mode relaxed Point and Print driver installation restriction." "WARN"
    }

    if ($FixPrinterLegacy) {
        $printPath = "HKLM:\SYSTEM\CurrentControlSet\Control\Print"
        Set-RegistryDword -Path $printPath -Name "RpcAuthnLevelPrivacyEnabled" -Value 0
        $script:RebootRequired = $true
        Write-Log "Applied legacy printer RPC compatibility fix for 0x0000011b (security reduced)." "WARN"
    } else {
        Write-Log "Legacy printer RPC fix not enabled. Add -FixPrinterLegacy if needed."
    }
}

function Show-Result {
    Write-Host ""
    Write-Host "================ DONE ================"
    Write-Host ("Log file: {0}" -f $script:LogPath)
    if ($script:RebootRequired) {
        Write-Host "Reboot is recommended before testing."
    }
    Write-Host "Quick tests:"
    Write-Host "  1) Open: \\target-ip\share-name"
    Write-Host "  2) Add printer: \\target-host\printer-share-name"
    Write-Host "  3) If auth behavior is unexpected, clear SMB sessions: net use * /delete /y"
    Write-Host "======================================"
}

try {
    Write-Log "Starting LAN share one-click repair..."
    Assert-Admin

    $osInfo = Get-OsInfo
    Write-Log ("OS: {0} ({1})" -f $osInfo.Caption, $osInfo.Version)
    if ($osInfo.IsWin7) {
        Write-Log "Windows 7 detected. This OS is out of support; use only as temporary legacy endpoint." "WARN"
    }

    Configure-DiscoveryAndSharing
    Configure-SmbPolicy -OsInfo $osInfo
    Refresh-SmbClientState
    Configure-PrinterPolicy
    Write-Log "All repair steps completed."
    Show-Result
} catch {
    Write-Log ("Repair failed: " + $_.Exception.Message) "ERROR"
    throw
}
