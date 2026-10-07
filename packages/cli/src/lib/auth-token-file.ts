import { execFileSync } from "node:child_process";
import {
	closeSync,
	existsSync,
	fstatSync,
	openSync,
	readFileSync,
	type Stats,
	writeFileSync,
} from "node:fs";
import { join } from "node:path";
import { PRIVATE_DIR_MODE, writePrivateFileAtomic } from "./private-file";

function normalizedPath(path: string, label: string): string {
	const normalized = path.trim();
	if (!normalized || normalized.includes("\0")) throw new Error(`${label} must be a valid path`);
	return normalized;
}

function windowsOwnerOnly(path: string, label: string, protect = false): void {
	const literal = `'${path.replaceAll("'", "''")}'`;
	const script = `
$ErrorActionPreference = 'Stop'
$sid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$path = ${literal}
${
	protect
		? `$acl = New-Object System.Security.AccessControl.FileSecurity
$acl.SetOwner($sid)
$acl.SetAccessRuleProtection($true, $false)
$acl.AddAccessRule((New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'Allow')))
Set-Acl -LiteralPath $path -AclObject $acl`
		: ""
}
$acl = Get-Acl -LiteralPath $path
$owner = $acl.GetOwner([System.Security.Principal.SecurityIdentifier])
if ($owner.Value -ne $sid.Value) { throw 'Wrong token file owner.' }
foreach ($rule in $acl.GetAccessRules($true, $true, [System.Security.Principal.SecurityIdentifier])) {
  if ($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Value -ne $sid.Value) {
    throw 'Token file grants access to another identity.'
  }
}
`;
	try {
		execFileSync(
			"powershell.exe",
			["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", script],
			{
				timeout: 20_000,
				stdio: "pipe",
			},
		);
	} catch {
		throw new Error(`${label} ${path} must be accessible only by its owner.`);
	}
}

function assertOwnerOnly(stats: Stats, path: string, label: string): void {
	if (!stats.isFile()) throw new Error(`${label} ${path} must be a regular file.`);
	if (process.platform === "win32") {
		windowsOwnerOnly(path, label);
		return;
	}
	if ((stats.mode & 0o077) !== 0) {
		throw new Error(`${label} ${path} must be readable only by its owner (mode 0600).`);
	}
	const uid = process.getuid?.();
	if (uid !== undefined && stats.uid !== uid) {
		throw new Error(`${label} ${path} must be owned by the current user.`);
	}
}

export function readAuthTokenFile(path: string, label = "--auth-token-file"): string {
	const normalized = normalizedPath(path, label);
	let fd: number;
	try {
		fd = openSync(normalized, "r");
	} catch {
		throw new Error(`${label} ${normalized} could not be read.`);
	}
	try {
		assertOwnerOnly(fstatSync(fd), normalized, label);
		const token = readFileSync(fd, "utf-8").trim();
		if (!token) throw new Error(`${label} ${normalized} is empty`);
		return token;
	} finally {
		closeSync(fd);
	}
}

export function loadAuthTokenFile(path: string | undefined, label = "--auth-token-file"): void {
	if (!path) return;
	process.env.CLAWDI_AUTH_TOKEN = readAuthTokenFile(path, label);
}

/** Persist an environment credential for a supervisor without putting it in its unit. */
export function persistAuthTokenFile(root: string, token: string): string {
	const normalizedToken = token.trim();
	if (!normalizedToken) throw new Error("CLAWDI_AUTH_TOKEN must not be empty");
	const path = join(root, "auth-token");
	if (existsSync(path)) readAuthTokenFile(path, "daemon auth token file");
	if (process.platform === "win32") {
		// POSIX mode bits do not express Windows ACLs. Secure the empty file
		// before writing any bearer credential, then enforce the same ACL on read.
		if (!existsSync(path)) writePrivateFileAtomic(path, "", { dirMode: PRIVATE_DIR_MODE });
		windowsOwnerOnly(path, "daemon auth token file", true);
		writeFileSync(path, `${normalizedToken}\n`);
	} else {
		writePrivateFileAtomic(path, `${normalizedToken}\n`, { dirMode: PRIVATE_DIR_MODE });
	}
	readAuthTokenFile(path, "daemon auth token file");
	return path;
}
