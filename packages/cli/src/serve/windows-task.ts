import { execFileSync } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CurrentCliInvocation } from "../lib/current-cli-invocation";

export function powershellLiteral(value: string): string {
	if (value.includes("\0")) throw new Error("Windows task value contains NUL.");
	return `'${value.replaceAll("'", "''")}'`;
}

export function windowsTaskLogPath(root: string): string {
	return join(root, "serve", "windows-task", "daemon.log");
}

function powershell(script: string): string {
	return execFileSync(
		"powershell.exe",
		[
			"-NoLogo",
			"-NoProfile",
			"-NonInteractive",
			"-EncodedCommand",
			Buffer.from(`$ErrorActionPreference = 'Stop'\n${script}`, "utf16le").toString("base64"),
		],
		{ encoding: "utf8", windowsHide: true, timeout: 45_000, stdio: ["ignore", "pipe", "pipe"] },
	).trim();
}

// InteractiveToken (3), LeastPrivilege (0): no password or elevation. The SID
// scopes the task name even when multiple users share the machine.
const connect = `
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User.Value
$name = "Clawdi Sync $sid"
$service = New-Object -ComObject 'Schedule.Service'
$service.Connect()
$folder = $service.GetFolder('\\')
$task = $null
try { $task = $folder.GetTask($name) } catch {
  $exception = $_.Exception
  while ($exception.InnerException) { $exception = $exception.InnerException }
  if ($exception.HResult -ne -2147024894) { throw }
}
`;
const stop = `
if ($task) {
  $task.Stop(0)
  $deadline = [DateTime]::UtcNow.AddSeconds(20)
  while ($task.GetInstances(0).Count -gt 0) {
    if ([DateTime]::UtcNow -gt $deadline) { throw 'Clawdi task did not stop.' }
    Start-Sleep -Milliseconds 200
  }
}
`;

export function windowsTaskInstalled(): boolean {
	return powershell(`${connect}\nWrite-Output ([bool]$task)`) === "True";
}

export function windowsTaskRunning(): boolean {
	return (
		powershell(
			`${connect}\nWrite-Output ($task -and $task.State -eq 4 -and $task.GetInstances(0).Count -gt 0)`,
		) === "True"
	);
}

export function installWindowsTask(
	root: string,
	invocation: CurrentCliInvocation,
	env: readonly { key: string; value: string }[],
): { unit: string; instructions: string; replaced: boolean } {
	if (env.some(({ key }) => !/^[A-Z][A-Z0-9_]*$/.test(key))) {
		throw new Error("Invalid Windows task environment key.");
	}
	const replaced = windowsTaskInstalled();
	// Stop the old action before replacing its launcher. Task Scheduler owns the
	// action's process tree; no PID files, shell 'kill', or detached children.
	powershell(connect + stop);
	const directory = join(root, "serve", "windows-task");
	mkdirSync(directory, { recursive: true });
	// POSIX mode bits do not protect captured credentials on Windows. Restrict
	// inheritance before writing the launcher; Task Scheduler runs as this SID.
	powershell(`
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$acl = New-Object System.Security.AccessControl.DirectorySecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
$acl.AddAccessRule($rule)
$directoryInfo = New-Object System.IO.DirectoryInfo(${powershellLiteral(directory)})
$directoryInfo.SetAccessControl($acl)
`);
	const launcher = join(directory, "run.ps1");
	const log = windowsTaskLogPath(root);
	// Windows PowerShell 5.1 requires a BOM to read non-ASCII paths as UTF-8.
	writeFileSync(
		launcher,
		"\uFEFF" +
			[
				// Windows PowerShell represents redirected native stderr as ErrorRecords.
				// Daemon diagnostic output must not abort the supervising action.
				"$ErrorActionPreference = 'Continue'",
				"[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)",
				"$OutputEncoding = [Console]::OutputEncoding",
				...env.map(({ key, value }) => `$env:${key} = ${powershellLiteral(value)}`),
				// Pin UTF-16LE rather than relying on PowerShell's redirection defaults.
				`& ${[invocation.command, ...invocation.args].map(powershellLiteral).join(" ")} 2>&1 | Out-File -LiteralPath ${powershellLiteral(log)} -Encoding unicode -Append -ErrorAction Stop`,
				// Exit 2 requires user intervention. Other spontaneous exits must restart
				// just as launchd KeepAlive/systemd Restart=always do.
				"if ($LASTEXITCODE -eq 2) { exit 0 }; exit 1",
				"",
			].join("\n"),
		{ mode: 0o600 },
	);
	powershell(`${connect}
$definition = $service.NewTask(0)
$definition.RegistrationInfo.Description = 'Clawdi per-user background Sync'
$definition.Principal.UserId = $sid
$definition.Principal.LogonType = 3
$definition.Principal.RunLevel = 0
$definition.Settings.Enabled = $true
$definition.Settings.StartWhenAvailable = $true
$definition.Settings.DisallowStartIfOnBatteries = $false
$definition.Settings.StopIfGoingOnBatteries = $false
$definition.Settings.ExecutionTimeLimit = 'PT0S'
$definition.Settings.MultipleInstances = 2
$definition.Settings.AllowHardTerminate = $true
$definition.Settings.RestartInterval = 'PT1M'
$definition.Settings.RestartCount = 999
$trigger = $definition.Triggers.Create(9)
$trigger.UserId = $sid
$action = $definition.Actions.Create(0)
$action.Path = "$env:SystemRoot\\System32\\WindowsPowerShell\\v1.0\\powershell.exe"
$action.Arguments = ${powershellLiteral(`-NoLogo -NoProfile -NonInteractive -WindowStyle Hidden -ExecutionPolicy Bypass -File "${launcher}"`)}
$task = $folder.RegisterTaskDefinition($name, $definition, 6, $sid, $null, 3, $null)
$null = $task.Run($null)
`);
	return {
		unit: launcher,
		instructions: "Clawdi Sync starts at user logon. Manage it with clawdi daemon.",
		replaced,
	};
}

export function stopWindowsTask(): void {
	powershell(connect + stop);
}

export function restartWindowsTask(): void {
	powershell(
		`${connect}\nif (!$task) { throw 'Clawdi task is not installed.' }\n${stop}\n$null = $task.Run($null)`,
	);
}

export function uninstallWindowsTask(root: string): { removed: boolean } {
	const removed =
		powershell(`${connect}\n${stop}\nif ($task) { $folder.DeleteTask($name, 0); 'removed' }`) ===
		"removed";
	rmSync(join(root, "serve", "windows-task"), { recursive: true, force: true });
	return { removed };
}

export function windowsTaskStatus(): string[] {
	return powershell(
		`${connect}\nif ($task) { "task: $name"; "state: $($task.State)" } else { 'task: not installed' }`,
	).split(/\r?\n/);
}
