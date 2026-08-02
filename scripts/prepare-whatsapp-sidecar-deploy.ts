import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	readFileSync,
	renameSync,
	writeFileSync,
} from "node:fs";
import { dirname, resolve } from "node:path";

const REGISTRY_KEY = "CHANNEL_WHATSAPP_BAILEYS_SIDECARS_JSON";
const GENERATED_BEGIN = "# BEGIN CLAWDI GENERATED WHATSAPP SIDECAR SECRETS";
const GENERATED_END = "# END CLAWDI GENERATED WHATSAPP SIDECAR SECRETS";
const UUID_PATTERN = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

type RegistryEntry = {
	account_id?: string;
	api_token: string;
	unix_socket_path: string;
	timeout_seconds?: number;
};

export type SidecarDeployAccount = {
	account_id: string;
	accessory_name: string;
	socket_path: string;
	token_secret_name: string;
};

export type SidecarDeployManifest = {
	schema_version: 1;
	accounts: SidecarDeployAccount[];
};

export function prepareWhatsAppSidecarDeploy(input: {
	rawRegistry: string;
	secretsPath: string;
	manifestPath: string;
}): SidecarDeployManifest {
	const registry = parseRegistry(input.rawRegistry);
	const accounts = Object.entries(registry)
		.sort(([left], [right]) => left.localeCompare(right))
		.map(([accountId, entry]) => {
			const compactId = accountId.replaceAll("-", "");
			return {
				account_id: accountId,
				accessory_name: `whatsapp-baileys-${compactId}`,
				socket_path: entry.unix_socket_path,
				token_secret_name: `CLAWDI_WA_SIDECAR_TOKEN_${compactId.toUpperCase()}`,
			} satisfies SidecarDeployAccount;
		});
	const manifest: SidecarDeployManifest = { schema_version: 1, accounts };
	writeManifest(input.manifestPath, manifest);
	const canonicalRegistry = Object.fromEntries(
		accounts.map((account) => [account.account_id, registry[account.account_id]]),
	);
	writeGeneratedSecrets(input.secretsPath, JSON.stringify(canonicalRegistry), registry, accounts);
	return manifest;
}

function parseRegistry(raw: string): Record<string, RegistryEntry> {
	let value: unknown;
	try {
		value = JSON.parse(raw);
	} catch {
		throw new Error(`${REGISTRY_KEY} must be valid JSON`);
	}
	if (!isRecord(value)) throw new Error(`${REGISTRY_KEY} must be an object`);
	const result: Record<string, RegistryEntry> = {};
	const socketPaths = new Set<string>();
	const apiTokens = new Set<string>();
	for (const [accountId, untypedEntry] of Object.entries(value)) {
		if (!UUID_PATTERN.test(accountId) || accountId !== accountId.toLowerCase()) {
			throw new Error(`${REGISTRY_KEY} keys must be canonical lowercase UUIDs`);
		}
		if (!isRecord(untypedEntry)) throw new Error(`invalid sidecar entry for ${accountId}`);
		const allowed = new Set(["account_id", "api_token", "unix_socket_path", "timeout_seconds"]);
		if (Object.keys(untypedEntry).some((key) => !allowed.has(key))) {
			throw new Error(`sidecar entry for ${accountId} has unknown fields`);
		}
		if (untypedEntry.account_id !== undefined && untypedEntry.account_id !== accountId) {
			throw new Error(`sidecar account_id mismatch for ${accountId}`);
		}
		const expectedSocketPath = `/run/clawdi-whatsapp/${accountId}/sidecar.sock`;
		if (untypedEntry.unix_socket_path !== expectedSocketPath) {
			throw new Error(`sidecar ${accountId} must use its stable account-scoped socket path`);
		}
		if (socketPaths.has(expectedSocketPath))
			throw new Error("sidecar socket paths must be disjoint");
		socketPaths.add(expectedSocketPath);
		if (
			typeof untypedEntry.api_token !== "string" ||
			!/^[A-Za-z0-9_-]{43,128}$/.test(untypedEntry.api_token)
		) {
			throw new Error(`sidecar ${accountId} requires a 43-128 character base64url api_token`);
		}
		if (apiTokens.has(untypedEntry.api_token)) {
			throw new Error("sidecar api_token values must be unique per account");
		}
		apiTokens.add(untypedEntry.api_token);
		if (
			untypedEntry.timeout_seconds !== undefined &&
			(typeof untypedEntry.timeout_seconds !== "number" ||
				!Number.isFinite(untypedEntry.timeout_seconds) ||
				untypedEntry.timeout_seconds <= 0 ||
				untypedEntry.timeout_seconds > 30)
		) {
			throw new Error(`sidecar ${accountId} has invalid timeout_seconds`);
		}
		result[accountId] = {
			...(untypedEntry.account_id === accountId ? { account_id: accountId } : {}),
			api_token: untypedEntry.api_token,
			unix_socket_path: expectedSocketPath,
			...(typeof untypedEntry.timeout_seconds === "number"
				? { timeout_seconds: untypedEntry.timeout_seconds }
				: {}),
		};
	}
	return result;
}

function writeManifest(path: string, manifest: SidecarDeployManifest): void {
	assertSafeOutputPath(path);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const temporaryPath = `${path}.tmp`;
	assertSafeOutputPath(temporaryPath);
	writeFileSync(temporaryPath, `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
	chmodSync(temporaryPath, 0o600);
	renameSync(temporaryPath, path);
}

function writeGeneratedSecrets(
	path: string,
	rawRegistry: string,
	registry: Record<string, RegistryEntry>,
	accounts: SidecarDeployAccount[],
): void {
	assertSafeOutputPath(path);
	mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
	const existing = existsSync(path) ? readFileSync(path, "utf8") : "";
	const base = removeGeneratedBlock(existing);
	const generatedKeys = [REGISTRY_KEY, ...accounts.map((account) => account.token_secret_name)];
	for (const key of generatedKeys) {
		if (new RegExp(`^${key}=`, "m").test(base)) {
			throw new Error(`${key} must be supplied only through the generated sidecar secret block`);
		}
	}
	const tokenLines = accounts.map((account) => {
		const token = registry[account.account_id]?.api_token;
		if (!token) throw new Error(`missing materialized token for ${account.account_id}`);
		return `${account.token_secret_name}=${JSON.stringify(token)}`;
	});
	const generated = [
		GENERATED_BEGIN,
		`${REGISTRY_KEY}=${JSON.stringify(rawRegistry)}`,
		...tokenLines,
		GENERATED_END,
	].join("\n");
	const content = base.trim() ? `${base.trimEnd()}\n${generated}\n` : `${generated}\n`;
	const temporaryPath = `${path}.tmp`;
	assertSafeOutputPath(temporaryPath);
	writeFileSync(temporaryPath, content, { mode: 0o600 });
	chmodSync(temporaryPath, 0o600);
	renameSync(temporaryPath, path);
}

function removeGeneratedBlock(source: string): string {
	const begin = source.indexOf(GENERATED_BEGIN);
	const end = source.indexOf(GENERATED_END);
	if (begin === -1 && end === -1) return source;
	if (
		begin === -1 ||
		end === -1 ||
		end < begin ||
		source.indexOf(GENERATED_BEGIN, begin + 1) !== -1
	) {
		throw new Error("invalid generated sidecar secret block");
	}
	return `${source.slice(0, begin)}${source.slice(end + GENERATED_END.length)}`.trim();
}

function assertSafeOutputPath(path: string): void {
	if (resolve(path) !== path) throw new Error("sidecar deployment output paths must be absolute");
	if (!existsSync(path)) return;
	const stat = lstatSync(path);
	const uid = process.getuid?.();
	const gid = process.getgid?.();
	if (
		!stat.isFile() ||
		stat.isSymbolicLink() ||
		uid === undefined ||
		gid === undefined ||
		stat.uid !== uid ||
		stat.gid !== gid ||
		(stat.mode & 0o777) !== 0o600
	) {
		throw new Error("sidecar deployment output must be an owned mode-600 regular file");
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

if (import.meta.main) {
	const repoRoot = resolve(import.meta.dir, "..");
	const manifest = prepareWhatsAppSidecarDeploy({
		rawRegistry: process.env[REGISTRY_KEY] ?? "",
		secretsPath: resolve(repoRoot, ".kamal/secrets"),
		manifestPath: resolve(repoRoot, ".kamal/whatsapp-sidecars.json"),
	});
	console.log(`Prepared ${manifest.accounts.length} WhatsApp sidecar account(s).`);
}
