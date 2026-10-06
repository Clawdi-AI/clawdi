param(
    [Parameter(Mandatory = $true)][string] $Repository,
    [Parameter(Mandatory = $true)][string] $Bun,
    [string] $TestRoot,
    [switch] $Unelevated
)
Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function ConvertTo-TestLiteral([string] $Value) { return "'" + $Value.Replace("'", "''") + "'" }

if ($Unelevated) {
    $outcome = Join-Path $TestRoot 'outcome.json'
    $process = $null
    $result = @{ Code = 1; Error = '' }
    try {
        $principal = [Security.Principal.WindowsPrincipal]::new([Security.Principal.WindowsIdentity]::GetCurrent())
        if ($principal.IsInRole([Security.Principal.WindowsBuiltInRole]::Administrator)) { throw 'CI test task must run without elevation.' }
        $env:CLAWDI_WINDOWS_TEST_ROOT = $TestRoot
        $env:CLAWDI_NATIVE_BINARY = Join-Path $Repository 'packages\cli\dist-native\win32-x64\clawdi.exe'
        $env:CLAWDI_HOME = Join-Path $TestRoot 'clawdi'
        $env:CODEX_HOME = Join-Path $TestRoot 'codex'
        $env:CLAWDI_NO_AUTO_UPDATE = '1'
        $env:CLAWDI_NO_UPDATE_CHECK = '1'
        $env:NO_COLOR = '1'
        $env:TEMP = Join-Path $TestRoot 'tmp'
        $env:TMP = $env:TEMP
        $null = New-Item -ItemType Directory -Path $env:TEMP -Force
        $info = New-Object Diagnostics.ProcessStartInfo
        $info.FileName = $Bun
        $info.WorkingDirectory = Join-Path $Repository 'packages\cli'
        $info.Arguments = 'test --isolate --max-concurrency=1 --timeout=30000 src/lib/native-distribution.test.ts src/lib/native-activation.test.ts tests/e2e/windows-native.e2e.test.ts'
        $info.UseShellExecute = $false
        $info.RedirectStandardOutput = $true
        $info.RedirectStandardError = $true
        $process = [Diagnostics.Process]::Start($info)
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit(900000)) {
            & "$env:SystemRoot\System32\taskkill.exe" /PID $process.Id /T /F | Out-Null
            throw 'Windows native tests timed out.'
        }
        [IO.File]::WriteAllText((Join-Path $TestRoot 'stdout.log'), $stdout.Result)
        [IO.File]::WriteAllText((Join-Path $TestRoot 'stderr.log'), $stderr.Result)
        $result.Code = $process.ExitCode
    } catch {
        $result.Error = $_.Exception.Message
    } finally {
        if ($process) { $process.Dispose() }
        [IO.File]::WriteAllText($outcome, ($result | ConvertTo-Json -Compress))
    }
    exit $result.Code
}

# GitHub's Windows runner is elevated. Run the tests with its existing user's
# InteractiveToken at LeastPrivilege, so the real installer admin check stays enabled.
$TestRoot = Join-Path $env:RUNNER_TEMP "clawdi-windows-$([Guid]::NewGuid())"
$null = New-Item -ItemType Directory -Path $TestRoot
$name = "Clawdi Native CI $([Guid]::NewGuid())"
$service = $null
$folder = $null
$registered = $false
try {
    $service = New-Object -ComObject 'Schedule.Service'
    $service.Connect()
    $folder = $service.GetFolder('\')
    $sid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
    $definition = $service.NewTask(0)
    $definition.Principal.UserId = $sid
    $definition.Principal.LogonType = 3
    $definition.Principal.RunLevel = 0
    $definition.Settings.ExecutionTimeLimit = 'PT16M'
    $definition.Settings.DisallowStartIfOnBatteries = $false
    $definition.Settings.StopIfGoingOnBatteries = $false
    $action = $definition.Actions.Create(0)
    $action.Path = "$env:SystemRoot\System32\WindowsPowerShell\v1.0\powershell.exe"
    $command = '& ' + (ConvertTo-TestLiteral $PSCommandPath) + ' -Unelevated -Repository ' + (ConvertTo-TestLiteral $Repository) +
        ' -Bun ' + (ConvertTo-TestLiteral $Bun) + ' -TestRoot ' + (ConvertTo-TestLiteral $TestRoot)
    $encoded = [Convert]::ToBase64String([Text.Encoding]::Unicode.GetBytes($command))
    $action.Arguments = "-NoProfile -NonInteractive -ExecutionPolicy Bypass -EncodedCommand $encoded"
    $task = $folder.RegisterTaskDefinition($name, $definition, 6, $sid, $null, 3, $null)
    $registered = $true
    $null = $task.Run($null)
    $outcome = Join-Path $TestRoot 'outcome.json'
    $deadline = [DateTime]::UtcNow.AddMinutes(16)
    while (-not (Test-Path -LiteralPath $outcome)) {
        if ([DateTime]::UtcNow -gt $deadline) { throw 'Unelevated Windows CI task did not complete.' }
        Start-Sleep -Milliseconds 500
    }
    foreach ($log in @('stdout.log', 'stderr.log')) {
        $path = Join-Path $TestRoot $log
        if (Test-Path -LiteralPath $path) { Get-Content -LiteralPath $path }
    }
    $result = Get-Content -LiteralPath $outcome -Raw | ConvertFrom-Json
    if ($result.Code -ne 0) { throw "Windows native tests failed ($($result.Code)): $($result.Error)" }
} finally {
    try {
        if ($registered) {
            $task = $folder.GetTask($name)
            if ($task.GetInstances(0).Count -gt 0) { $task.Stop(0) }
            $folder.DeleteTask($name, 0)
        }
    } finally {
        Remove-Item -LiteralPath $TestRoot -Recurse -Force
    }
}
