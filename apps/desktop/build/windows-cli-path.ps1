param(
  [Parameter(Mandatory = $true)]
  [ValidateSet("Add", "Remove")]
  [string]$Action,

  [Parameter(Mandatory = $true)]
  [string]$BinPath,

  [Parameter(Mandatory = $true)]
  [string]$LauncherPath
)

$ErrorActionPreference = "Stop"
$marker = "@rem Clawdi Desktop CLI launcher v1"
$environment = [Microsoft.Win32.Registry]::CurrentUser.CreateSubKey("Environment", $true)

try {
  $rawPath = [string]$environment.GetValue(
    "Path",
    "",
    [Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames
  )
  $parts = @($rawPath -split ";" | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
  $separator = [System.IO.Path]::DirectorySeparatorChar
  $normalizedBin = $BinPath.TrimEnd($separator)
  $matchesBin = {
    param([string]$entry)
    [StringComparer]::OrdinalIgnoreCase.Equals($entry.Trim().TrimEnd($separator), $normalizedBin)
  }

  if ($Action -eq "Add") {
    if (-not ($parts | Where-Object { & $matchesBin $_ })) {
      $parts += $BinPath
    }
  } else {
    $parts = @($parts | Where-Object { -not (& $matchesBin $_) })
    if (Test-Path -LiteralPath $LauncherPath -PathType Leaf) {
      $firstLine = Get-Content -LiteralPath $LauncherPath -TotalCount 1
      if ($firstLine -eq $marker) {
        Remove-Item -LiteralPath $LauncherPath -Force
        $launcherDirectory = Split-Path -Parent $LauncherPath
        if ((Test-Path -LiteralPath $launcherDirectory -PathType Container) -and
            -not (Get-ChildItem -LiteralPath $launcherDirectory -Force | Select-Object -First 1)) {
          Remove-Item -LiteralPath $launcherDirectory -Force
        }
      }
    }
  }

  $updatedPath = $parts -join ";"
  if ($updatedPath -ne $rawPath) {
    $environment.SetValue("Path", $updatedPath, [Microsoft.Win32.RegistryValueKind]::ExpandString)
  }
} finally {
  $environment.Dispose()
}

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;
public static class ClawdiEnvironmentBroadcast {
  [DllImport("user32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
  public static extern IntPtr SendMessageTimeout(
    IntPtr hWnd,
    uint Msg,
    UIntPtr wParam,
    string lParam,
    uint flags,
    uint timeout,
    out UIntPtr result
  );
}
"@

$result = [UIntPtr]::Zero
[void][ClawdiEnvironmentBroadcast]::SendMessageTimeout(
  [IntPtr]0xffff,
  0x001A,
  [UIntPtr]::Zero,
  "Environment",
  0x0002,
  5000,
  [ref]$result
)
