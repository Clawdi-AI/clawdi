Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Net.ServicePointManager]::SecurityProtocol = [Net.ServicePointManager]::SecurityProtocol -bor [Net.SecurityProtocolType]::Tls12

function Copy-ClawdiBoundedStream($InputStream, $OutputStream, [long] $Maximum) {
    $buffer = New-Object byte[] 65536
    $total = 0L
    $timer = [Diagnostics.Stopwatch]::StartNew()
    while (($count = $InputStream.Read($buffer, 0, $buffer.Length)) -gt 0) {
        $total += $count
        if ($total -gt $Maximum) { throw 'Download or archive exceeds the size limit.' }
        if ($timer.Elapsed.TotalSeconds -gt 180) { throw 'Download or archive timed out.' }
        $OutputStream.Write($buffer, 0, $count)
    }
}

function Get-ClawdiDownload([string] $Source, [string] $Destination, [long] $Maximum, [bool] $Local = $false) {
    $response = $null
    $inputStream = $null
    $outputStream = $null
    try {
        if ($Local) {
            $inputStream = [IO.File]::OpenRead($Source)
            if ($inputStream.Length -gt $Maximum) { throw 'Download exceeds the size limit.' }
        } else {
            $uri = [Uri] $Source
            if ($uri.Scheme -ne 'https') { throw 'Downloads require HTTPS.' }
            $request = [Net.HttpWebRequest]::Create($uri)
            $request.Timeout = 180000
            $request.ReadWriteTimeout = 10000
            $request.MaximumAutomaticRedirections = 5
            $response = $request.GetResponse()
            if ($response.ResponseUri.Scheme -ne 'https') { throw 'Download redirected outside HTTPS.' }
            if ($response.ContentLength -gt $Maximum) { throw 'Download exceeds the size limit.' }
            $inputStream = $response.GetResponseStream()
        }
        $outputStream = [IO.File]::Create($Destination)
        Copy-ClawdiBoundedStream $inputStream $outputStream $Maximum
    } finally {
        if ($outputStream) { $outputStream.Dispose() }
        if ($inputStream) { $inputStream.Dispose() }
        if ($response) { $response.Dispose() }
    }
}

function ConvertTo-ClawdiArgument([string] $Value) {
    # Windows CommandLineToArgvW quoting, including trailing backslashes.
    return '"' + [regex]::Replace([regex]::Replace($Value, '(\\*)"', '$1$1\"'), '(\\+)$', '$1$1') + '"'
}

function Invoke-ClawdiNative([string] $Command, [string[]] $Arguments, [int] $Timeout = 20000) {
    $info = New-Object Diagnostics.ProcessStartInfo
    $info.FileName = $Command
    $info.Arguments = ($Arguments | ForEach-Object { ConvertTo-ClawdiArgument $_ }) -join ' '
    $info.UseShellExecute = $false
    $info.CreateNoWindow = $true
    $info.RedirectStandardOutput = $true
    $info.RedirectStandardError = $true
    $info.StandardOutputEncoding = [Text.Encoding]::UTF8
    $info.StandardErrorEncoding = [Text.Encoding]::UTF8
    $process = New-Object Diagnostics.Process
    $process.StartInfo = $info
    try {
        if (-not $process.Start()) { throw "Could not start $Command." }
        $stdout = $process.StandardOutput.ReadToEndAsync()
        $stderr = $process.StandardError.ReadToEndAsync()
        if (-not $process.WaitForExit($Timeout)) {
            $process.Kill()
            $process.WaitForExit()
            throw "Command timed out: $Command"
        }
        if ($process.ExitCode -ne 0) { throw "Command failed ($($process.ExitCode)): $($stderr.Result.Trim())" }
        return $stdout.Result.TrimEnd("`r", "`n")
    } finally {
        $process.Dispose()
    }
}

function Read-ClawdiManifest([string] $Path, [string] $Version, [string] $Target) {
    $text = [IO.File]::ReadAllText($Path, [Text.UTF8Encoding]::new($false, $true))
    $lines = $text.Split("`n")
    if ($lines[-1] -ceq '') { $lines = $lines[0..($lines.Length - 2)] }
    if ($lines.Length -lt 2 -or $lines[0] -cne 'clawdi.nativeRelease.v2' -or $lines[1] -cne "version`t$Version") {
        throw 'Invalid exact native release manifest.'
    }
    $supported = @('linux-x64', 'linux-arm64', 'linux-x64-musl', 'linux-arm64-musl', 'darwin-x64', 'darwin-arm64', 'win32-x64', 'win32-arm64')
    $seen = @{}
    $selected = $null
    foreach ($line in ($lines | Select-Object -Skip 2)) {
        $fields = $line.Split("`t")
        if ($fields.Length -lt 2 -or $fields[0] -cne 'artifact' -or $supported -cnotcontains $fields[1]) { continue }
        if ($fields.Length -ne 4 -or $seen.ContainsKey($fields[1]) -or
            $fields[2] -cne "clawdi-cli-$($fields[1]).tar.gz" -or $fields[3] -cnotmatch '\A[0-9a-f]{64}\z') {
            throw 'Invalid native release manifest artifact.'
        }
        $seen[$fields[1]] = $true
        if ($fields[1] -ceq $Target) { $selected = @{ Asset = $fields[2]; Sha256 = $fields[3] } }
    }
    if (-not $selected) { throw "Native release does not support $Target." }
    return $selected
}

function Add-ClawdiPath([string] $Directory) {
    if ($env:CLAWDI_NO_MODIFY_PATH -eq '1') { return }
    $userPath = [Environment]::GetEnvironmentVariable('Path', 'User')
    $entries = @($userPath -split ';' | ForEach-Object { $_.Trim().TrimEnd('\', '/') })
    if ($entries -notcontains $Directory.TrimEnd('\', '/')) {
        $updated = if ($userPath) { "$Directory;$userPath" } else { $Directory }
        [Environment]::SetEnvironmentVariable('Path', $updated, 'User')
        Write-Host "Added $Directory to your user PATH. Open a new terminal to use clawdi."
    }
    if (@($env:Path -split ';' | ForEach-Object { $_.Trim().TrimEnd('\', '/') }) -notcontains $Directory.TrimEnd('\', '/')) {
        $env:Path = "$Directory;$env:Path"
    }
}

$bootstrap = $null
$stage = $null
try {
    if ($env:OS -ne 'Windows_NT') { throw 'This installer requires Windows.' }
    $prefix = if ($env:CLAWDI_INSTALL_PREFIX) { $env:CLAWDI_INSTALL_PREFIX } else { Join-Path $env:USERPROFILE '.local' }
    if ($prefix -notmatch '\A(?:[A-Za-z]:[\\/]|\\\\[^\\]+\\[^\\]+(?:\\|$))' -or $prefix.Contains(';')) {
        throw 'CLAWDI_INSTALL_PREFIX must be an absolute path without semicolons.'
    }
    $prefix = [IO.Path]::GetFullPath($prefix)
    $architecture = if ($env:PROCESSOR_ARCHITEW6432) { $env:PROCESSOR_ARCHITEW6432 } else { $env:PROCESSOR_ARCHITECTURE }
    $arch = switch ($architecture) { 'AMD64' { 'x64' }; 'ARM64' { 'arm64' }; default { throw "Unsupported architecture: $architecture" } }
    $target = "win32-$arch"
    $tar = Join-Path $env:SystemRoot 'System32\tar.exe'
    if (-not (Test-Path -LiteralPath $tar -PathType Leaf)) { throw 'tar.exe is required (Windows 10 1803+ or Windows 11).' }
    $bootstrap = Join-Path ([IO.Path]::GetTempPath()) "clawdi-bootstrap-$([Guid]::NewGuid())"
    $null = New-Item -ItemType Directory -Path $bootstrap
    $version = $env:CLAWDI_VERSION
    if (-not $version) {
        $registry = Join-Path $bootstrap 'registry.json'
        Get-ClawdiDownload 'https://registry.npmjs.org/-/package/clawdi/dist-tags' $registry 65536
        $tags = Get-Content -LiteralPath $registry -Raw | ConvertFrom-Json
        $property = $tags.PSObject.Properties['latest']
        if (-not $property -or $property.Value -isnot [string]) { throw 'Registry returned an invalid release channel.' }
        $version = $property.Value
    }
    if ($version -cnotmatch '\A[0-9A-Za-z.+-]+\z') { throw "Invalid exact version: $version" }
    Write-Host "Installing clawdi v$version for $target..."
    $releaseBase = "https://github.com/Clawdi-AI/clawdi/releases/download/clawdi-cli-v$version"
    # Test-only override: an absolute local fake release directory, like the Unix curl fixture.
    $localRelease = -not [string]::IsNullOrEmpty($env:CLAWDI_RELEASE_BASE)
    if ($localRelease) {
        if (-not [IO.Path]::IsPathRooted($env:CLAWDI_RELEASE_BASE) -or -not (Test-Path -LiteralPath $env:CLAWDI_RELEASE_BASE -PathType Container)) {
            throw 'CLAWDI_RELEASE_BASE must be an absolute local test release directory.'
        }
        $releaseBase = $env:CLAWDI_RELEASE_BASE.TrimEnd('\', '/')
    }
    $manifestName = 'clawdi-cli-manifest-v2.txt'
    $manifest = Join-Path $bootstrap $manifestName
    try { Get-ClawdiDownload "$releaseBase/$manifestName" $manifest 65536 $localRelease } catch {
        $exception = $_.Exception
        while ($exception.InnerException) { $exception = $exception.InnerException }
        if ($exception -is [IO.FileNotFoundException] -or
            ($exception -is [Net.WebException] -and $exception.Response -and [int]$exception.Response.StatusCode -eq 404)) {
            throw "This version has no Windows build; use npm i -g clawdi@$version (Node 24+)."
        }
        throw
    }
    $artifact = Read-ClawdiManifest $manifest $version $target
    $archive = Join-Path $bootstrap $artifact.Asset
    Get-ClawdiDownload "$releaseBase/$($artifact.Asset)" $archive 268435456 $localRelease
    if ((Get-FileHash -LiteralPath $archive -Algorithm SHA256).Hash.ToLowerInvariant() -cne $artifact.Sha256) { throw 'Native artifact checksum mismatch.' }
    $nativeRoot = Join-Path $prefix 'share\clawdi'
    $null = New-Item -ItemType Directory -Path $nativeRoot -Force
    $stage = Join-Path $nativeRoot ".stage-$([Guid]::NewGuid())"
    $null = New-Item -ItemType Directory -Path $stage
    # Windows tar.exe is bsdtar; its default extraction refuses .. and symlink escapes.
    # https://github.com/libarchive/libarchive/blob/master/tar/bsdtar.1 (the -P option)
    $null = Invoke-ClawdiNative $tar @('-xzf', $archive, '-C', $stage, '--no-same-owner', '--no-same-permissions') 180000
    Copy-Item -LiteralPath $manifest -Destination (Join-Path $stage $manifestName)
    $executable = Join-Path $stage 'clawdi.exe'
    if ((Invoke-ClawdiNative $executable @('--version')) -cne $version) { throw 'Staged native executable failed version smoke.' }
    if ((Invoke-ClawdiNative $executable @('update', '--native-identity')) -cne "$version`t$target") { throw 'Staged native executable identity does not match the selected target.' }
    $launcher = Invoke-ClawdiNative $executable @('update', '--native-activate', '--native-stage', $stage, '--native-prefix', $prefix, '--native-version', $version, '--native-target', $target) 180000
    $current = Join-Path $nativeRoot 'current'
    if ($launcher -cne (Join-Path $current 'clawdi.exe')) { throw 'Native activation returned an unexpected launcher.' }
    Add-ClawdiPath $current
    Write-Host "Installed clawdi v$version at $launcher"
} catch {
    throw "clawdi install: $($_.Exception.Message)"
} finally {
    foreach ($directory in @($stage, $bootstrap)) {
        try {
            if ($directory -and (Test-Path -LiteralPath $directory)) { Remove-Item -LiteralPath $directory -Recurse -Force }
        } catch {
            # Cleanup must not mask the install result; the activating process has exited.
        }
    }
}
