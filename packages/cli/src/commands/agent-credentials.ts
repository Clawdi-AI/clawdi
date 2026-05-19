import { execFile } from "node:child_process";
import {
	chmodSync,
	copyFileSync,
	existsSync,
	mkdirSync,
	renameSync,
	statSync,
	writeFileSync,
} from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import { promisify } from "node:util";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { getClaudeHome, getCodexHome, getGhConfigHome } from "../adapters/paths";
import { ApiClient } from "../lib/api-client";
import { getAuth, getConfig, isLoggedIn } from "../lib/config";
import { resolveProjectId } from "../lib/project-resolver";

const MAX_PROFILE_FILE_BYTES = 1024 * 1024;
const CREDENTIAL_FILE_MODE = 0o600;
const execFileAsync = promisify(execFile);

type TargetStrategy = "adapter_default" | "explicit";
type SourceKind = "file" | "keychain";

interface BuiltInCredentialAdapter {
	logicalName: string;
	defaultPath: () => string;
}

const TOOL_ALIASES: Record<string, string> = {
	claude: "claude-code",
	claude_code: "claude-code",
	claudecode: "claude-code",
	github: "gh",
	"github-cli": "gh",
	github_cli: "gh",
};

const BUILTIN_CREDENTIAL_ADAPTERS: Record<string, BuiltInCredentialAdapter> = {
	codex: {
		logicalName: "auth.json",
		defaultPath: () => join(getCodexHome(), "auth.json"),
	},
	"claude-code": {
		logicalName: ".credentials.json",
		defaultPath: () => join(getClaudeHome(), ".credentials.json"),
	},
	gh: {
		logicalName: "hosts.yml",
		defaultPath: () => join(getGhConfigHome(), "hosts.yml"),
	},
};

interface CredentialFileSnapshot {
	logicalName: string;
	sourcePath: string;
	targetPath?: string;
	targetStrategy: TargetStrategy;
	sourceKind?: SourceKind;
	content: string;
	mode: number;
	size: number;
}

interface CredentialProfileEnvelope {
	schemaVersion: 1;
	kind: "local_agent_profile";
	tool: string;
	profile: string;
	importedAt: string;
	files: CredentialFileSnapshot[];
}

interface CredentialProfileResponse {
	id: string;
	project_id: string;
	tool: string;
	profile: string;
	updated_at: string;
}

interface CredentialProfileResolveResponse extends CredentialProfileResponse {
	payload: string;
}

interface ImportOptions {
	project?: string;
	profile?: string;
	source?: string;
	from?: string;
	to?: string;
	keychainService?: string;
	keychainAccount?: string;
	yes?: boolean;
	dryRun?: boolean;
	json?: boolean;
}

interface MaterializeOptions {
	project?: string;
	profile?: string;
	to?: string;
	yes?: boolean;
	dryRun?: boolean;
	json?: boolean;
	backup?: boolean;
}

interface FilePlan {
	logicalName: string;
	sourcePath: string;
	targetPath?: string;
	targetStrategy: TargetStrategy;
	sourceKind: SourceKind;
	keychainService?: string;
	keychainAccount?: string;
	mode: number;
	size?: number;
}

function requireAuth() {
	if (!isLoggedIn()) {
		console.log(chalk.red("Not logged in. Run `clawdi auth login` first."));
		process.exit(1);
	}
}

function expandHome(input: string): string {
	if (input === "~") return process.env.HOME ?? input;
	if (input.startsWith("~/")) return join(process.env.HOME ?? "~", input.slice(2));
	return input;
}

function normalizeName(input: string, label: string, maxLength = 80): string {
	const normalized = input
		.trim()
		.toLowerCase()
		.replace(/[^a-z0-9_.-]+/g, "-");
	if (!normalized) {
		throw new Error(`${label} must contain at least one letter or number.`);
	}
	if (normalized.length > maxLength) {
		throw new Error(`${label} is too long.`);
	}
	return normalized;
}

function canonicalTool(input: string): string {
	return TOOL_ALIASES[input] ?? input;
}

function builtInFilePlan(tool: string, from?: string, to?: string): FilePlan[] | null {
	const adapter = BUILTIN_CREDENTIAL_ADAPTERS[tool];
	if (!adapter) return null;
	const sourcePath = resolve(expandHome(from ?? adapter.defaultPath()));
	return [
		{
			logicalName: adapter.logicalName,
			sourcePath,
			targetPath: to ? resolve(expandHome(to)) : undefined,
			targetStrategy: to ? "explicit" : "adapter_default",
			sourceKind: "file",
			mode: 0o600,
		},
	];
}

function explicitFilePlan(tool: string, from: string, to?: string): FilePlan[] {
	return [
		{
			logicalName: `${tool}:${basename(from)}`,
			sourcePath: resolve(expandHome(from)),
			targetPath: to ? resolve(expandHome(to)) : resolve(expandHome(from)),
			targetStrategy: "explicit",
			sourceKind: "file",
			mode: 0o600,
		},
	];
}

function buildImportPlan(tool: string, opts: ImportOptions): FilePlan[] {
	const source = opts.source ?? "file";
	if (source !== "file" && source !== "keychain") {
		throw new Error(
			`Unsupported credential source "${source}". Supported sources are file and keychain.`,
		);
	}
	if (source === "keychain") {
		return keychainPlan(tool, opts);
	}
	const builtInPlan = builtInFilePlan(tool, opts.from, opts.to);
	if (builtInPlan) return builtInPlan;
	if (!opts.from) {
		throw new Error(
			`No built-in credential adapter for "${tool}". Built-ins are codex, claude-code, and gh. Pass --from <path> to import an explicit credential file.`,
		);
	}
	return explicitFilePlan(tool, opts.from, opts.to);
}

function keychainPlan(tool: string, opts: ImportOptions): FilePlan[] {
	if (opts.from) {
		throw new Error("--from cannot be used with --source keychain.");
	}
	if (!opts.keychainService || !opts.keychainAccount) {
		throw new Error(
			"--source keychain requires --keychain-service <service> and --keychain-account <account>. Clawdi does not guess credential-store item names.",
		);
	}
	const service = validateKeychainIdentifier(opts.keychainService, "Keychain service");
	const account = validateKeychainIdentifier(opts.keychainAccount, "Keychain account");
	return [
		{
			logicalName: `${tool}:keychain-password`,
			sourcePath: `keychain://${service}/${account}`,
			targetPath: opts.to ? resolve(expandHome(opts.to)) : undefined,
			targetStrategy: "explicit",
			sourceKind: "keychain",
			keychainService: service,
			keychainAccount: account,
			mode: 0o600,
		},
	];
}

function validateKeychainIdentifier(input: string, label: string): string {
	const value = input.trim();
	if (!value) {
		throw new Error(`${label} must not be empty.`);
	}
	for (let index = 0; index < value.length; index += 1) {
		const code = value.charCodeAt(index);
		if (code < 32 || code === 127) {
			throw new Error(`${label} must not contain control characters.`);
		}
	}
	return value;
}

function adapterTargetPath(tool: string, logicalName: string): string | null {
	const adapter = BUILTIN_CREDENTIAL_ADAPTERS[tool];
	return adapter?.logicalName === logicalName ? adapter.defaultPath() : null;
}

async function snapshotFile(plan: FilePlan): Promise<CredentialFileSnapshot> {
	if (plan.sourceKind === "keychain") {
		return await snapshotKeychain(plan);
	}
	if (!existsSync(plan.sourcePath)) {
		throw new Error(`Credential file not found: ${plan.sourcePath}`);
	}
	const stat = statSync(plan.sourcePath);
	if (!stat.isFile()) {
		throw new Error(`Credential path is not a file: ${plan.sourcePath}`);
	}
	if (stat.size > MAX_PROFILE_FILE_BYTES) {
		throw new Error(`Credential file is too large: ${plan.sourcePath}`);
	}
	const content = await readFile(plan.sourcePath, "utf-8");
	return {
		logicalName: plan.logicalName,
		sourcePath: plan.sourcePath,
		targetPath: plan.targetPath,
		targetStrategy: plan.targetStrategy,
		sourceKind: plan.sourceKind,
		content,
		mode: credentialFileMode(),
		size: stat.size,
	};
}

function previewPlan(plan: FilePlan): FilePlan {
	if (plan.sourceKind === "keychain") {
		return { ...plan, size: 0 };
	}
	if (!existsSync(plan.sourcePath)) {
		throw new Error(`Credential file not found: ${plan.sourcePath}`);
	}
	const stat = statSync(plan.sourcePath);
	if (!stat.isFile()) {
		throw new Error(`Credential path is not a file: ${plan.sourcePath}`);
	}
	if (stat.size > MAX_PROFILE_FILE_BYTES) {
		throw new Error(`Credential file is too large: ${plan.sourcePath}`);
	}
	return { ...plan, mode: credentialFileMode(), size: stat.size };
}

function assertKeychainAvailable() {
	if (process.platform !== "darwin") {
		throw new Error("macOS Keychain import is only available on macOS.");
	}
}

async function snapshotKeychain(plan: FilePlan): Promise<CredentialFileSnapshot> {
	assertKeychainAvailable();
	if (!plan.keychainService || !plan.keychainAccount) {
		throw new Error("Missing Keychain service/account.");
	}
	const { stdout } = await execFileAsync("security", [
		"find-generic-password",
		"-s",
		plan.keychainService,
		"-a",
		plan.keychainAccount,
		"-w",
	]);
	const content = stdout.replace(/\n$/, "");
	return {
		logicalName: plan.logicalName,
		sourcePath: plan.sourcePath,
		targetPath: plan.targetPath,
		targetStrategy: plan.targetStrategy,
		sourceKind: "keychain",
		content,
		mode: plan.mode,
		size: Buffer.byteLength(content),
	};
}

function buildEnvelope(
	tool: string,
	profile: string,
	files: CredentialFileSnapshot[],
): CredentialProfileEnvelope {
	return {
		schemaVersion: 1,
		kind: "local_agent_profile",
		tool,
		profile,
		importedAt: new Date().toISOString(),
		files,
	};
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}

function parseEnvelope(payload: string): CredentialProfileEnvelope {
	let parsed: unknown;
	try {
		parsed = JSON.parse(payload);
	} catch {
		throw new Error("Stored credential profile is not valid JSON.");
	}
	if (!isRecord(parsed)) throw new Error("Stored credential profile has invalid shape.");
	if (parsed.schemaVersion !== 1 || parsed.kind !== "local_agent_profile") {
		throw new Error("Stored credential profile uses an unsupported schema.");
	}
	if (typeof parsed.tool !== "string" || typeof parsed.profile !== "string") {
		throw new Error("Stored credential profile is missing tool metadata.");
	}
	if (!Array.isArray(parsed.files)) {
		throw new Error("Stored credential profile is missing files.");
	}
	const files: CredentialFileSnapshot[] = [];
	for (const entry of parsed.files) {
		if (!isRecord(entry)) throw new Error("Stored credential profile has an invalid file entry.");
		if (
			typeof entry.logicalName !== "string" ||
			typeof entry.sourcePath !== "string" ||
			typeof entry.targetStrategy !== "string" ||
			typeof entry.content !== "string" ||
			typeof entry.mode !== "number" ||
			typeof entry.size !== "number"
		) {
			throw new Error("Stored credential profile has an invalid file entry.");
		}
		if (entry.targetStrategy !== "adapter_default" && entry.targetStrategy !== "explicit") {
			throw new Error("Stored credential profile has an unsupported target strategy.");
		}
		const targetPath = typeof entry.targetPath === "string" ? entry.targetPath : undefined;
		const sourceKind =
			entry.sourceKind === "file" || entry.sourceKind === "keychain" ? entry.sourceKind : undefined;
		files.push({
			logicalName: entry.logicalName,
			sourcePath: entry.sourcePath,
			targetPath,
			targetStrategy: entry.targetStrategy,
			sourceKind,
			content: entry.content,
			mode: entry.mode,
			size: entry.size,
		});
	}
	return {
		schemaVersion: 1,
		kind: "local_agent_profile",
		tool: parsed.tool,
		profile: parsed.profile,
		importedAt: typeof parsed.importedAt === "string" ? parsed.importedAt : "",
		files,
	};
}

async function resolveProjectOption(project?: string): Promise<string | undefined> {
	if (!project) return undefined;
	const { apiUrl } = getConfig();
	const auth = getAuth();
	if (!auth?.apiKey) {
		throw new Error("Not signed in. Run `clawdi auth login` first.");
	}
	return await resolveProjectId(apiUrl, auth.apiKey, project);
}

function previewFiles(
	files: Array<{ logicalName: string; sourcePath?: string; targetPath?: string; size: number }>,
) {
	return files
		.map((file) => {
			const source = file.sourcePath ? ` from ${file.sourcePath}` : "";
			const target = file.targetPath ? ` -> ${file.targetPath}` : "";
			return `${file.logicalName}${source}${target} (${file.size} bytes)`;
		})
		.join("\n");
}

function writeAtomic(path: string, content: string, mode: number) {
	const dir = dirname(path);
	mkdirSync(dir, { recursive: true });
	const tmp = join(dir, `.${basename(path)}.tmp-${process.pid}-${Date.now()}`);
	writeFileSync(tmp, content, { mode });
	renameSync(tmp, path);
}

function credentialFileMode(): number {
	return CREDENTIAL_FILE_MODE;
}

function backupPath(path: string): string {
	const timestamp = new Date().toISOString().replace(/[-:.]/g, "");
	return `${path}.bak-${timestamp}-${process.pid}`;
}

function copyCredentialBackup(from: string, to: string): void {
	copyFileSync(from, to);
	chmodCredentialFile(to);
}

function chmodCredentialFile(path: string): void {
	try {
		chmodSync(path, credentialFileMode());
	} catch {
		// Windows may ignore POSIX modes. The write path still uses the
		// requested mode where the platform supports it.
	}
}

function materializeTarget(
	tool: string,
	file: CredentialFileSnapshot,
	overrideTo?: string,
): string {
	if (overrideTo) return resolve(expandHome(overrideTo));
	if (file.targetStrategy === "adapter_default") {
		const target = adapterTargetPath(tool, file.logicalName);
		if (target) return target;
	}
	if (file.targetPath) return file.targetPath;
	throw new Error(`No materialization target for ${file.logicalName}. Pass --to <path>.`);
}

export async function agentCredentialsImportCommand(
	toolInput: string,
	opts: ImportOptions = {},
): Promise<void> {
	requireAuth();
	const tool = canonicalTool(normalizeName(toolInput, "tool"));
	const profile = normalizeName(opts.profile ?? "default", "profile", 120);
	const plan = buildImportPlan(tool, opts);
	const previewPlans = plan.map(previewPlan);

	const preview = previewFiles(
		previewPlans.map((file) => ({
			logicalName: file.logicalName,
			sourcePath: file.sourcePath,
			targetPath: file.targetPath ?? adapterTargetPath(tool, file.logicalName) ?? undefined,
			size: file.size ?? 0,
		})),
	);

	if (opts.json) {
		console.log(
			JSON.stringify(
				{
					tool,
					profile,
					source: opts.source ?? "file",
					dry_run: Boolean(opts.dryRun),
					files: previewPlans.map((file) => ({
						logical_name: file.logicalName,
						source_path: file.sourcePath,
						target_path: file.targetPath ?? adapterTargetPath(tool, file.logicalName),
						size: file.size ?? 0,
					})),
				},
				null,
				2,
			),
		);
	} else {
		p.note(preview, `Credential profile ${tool}/${profile}`);
	}

	if (opts.dryRun) return;

	const hasKeychainSource = previewPlans.some((file) => file.sourceKind === "keychain");
	if (hasKeychainSource) {
		assertKeychainAvailable();
		if (opts.yes) {
			throw new Error(
				"--yes cannot be used with --source keychain; confirm interactively before reading Keychain.",
			);
		}
		if (!opts.json) {
			p.note(
				"macOS may show a system authorization prompt. Clawdi will read only the explicit Keychain service/account shown above.",
				"Keychain source",
			);
		}
	}

	if (!opts.yes) {
		const ok = await p.confirm({ message: "Import this credential profile into Clawdi Vault?" });
		if (p.isCancel(ok) || !ok) {
			p.cancel("Cancelled.");
			return;
		}
	}

	const files = await Promise.all(previewPlans.map(snapshotFile));
	const envelope = buildEnvelope(tool, profile, files);
	const projectId = await resolveProjectOption(opts.project);
	const api = new ApiClient();
	const response = await api.postJsonBody<CredentialProfileResponse>(
		"/api/vault/credential-profiles",
		{ tool, profile, payload: JSON.stringify(envelope) },
		projectId ? { project_id: projectId } : undefined,
	);

	if (!opts.json) {
		console.log(
			chalk.green(
				`✓ Imported ${files.length} credential file${files.length === 1 ? "" : "s"} to ${response.tool}/${response.profile}`,
			),
		);
	}
}

export async function agentCredentialsMaterializeCommand(
	toolInput: string,
	opts: MaterializeOptions = {},
): Promise<void> {
	requireAuth();
	const tool = canonicalTool(normalizeName(toolInput, "tool"));
	const profile = normalizeName(opts.profile ?? "default", "profile", 120);
	const projectId = await resolveProjectOption(opts.project);
	const api = new ApiClient();
	const resolved = await api.postJsonBody<CredentialProfileResolveResponse>(
		"/api/vault/credential-profiles/resolve",
		{
			tool,
			profile,
			project_id: projectId,
		},
	);
	const envelope = parseEnvelope(resolved.payload);
	if (opts.to && envelope.files.length !== 1) {
		throw new Error("--to can only be used with single-file credential profiles.");
	}
	const targets = envelope.files.map((file) => ({
		file,
		targetPath: materializeTarget(tool, file, opts.to),
	}));

	const preview = previewFiles(
		targets.map(({ file, targetPath }) => ({
			logicalName: file.logicalName,
			targetPath,
			size: file.size,
		})),
	);

	if (opts.json) {
		console.log(
			JSON.stringify(
				{
					tool,
					profile,
					dry_run: Boolean(opts.dryRun),
					files: targets.map(({ file, targetPath }) => ({
						logical_name: file.logicalName,
						target_path: targetPath,
						size: file.size,
					})),
				},
				null,
				2,
			),
		);
	} else {
		p.note(preview, `Materialize credential profile ${tool}/${profile}`);
	}

	if (opts.dryRun) return;

	if (!opts.yes) {
		const ok = await p.confirm({ message: "Write these local credential files?" });
		if (p.isCancel(ok) || !ok) {
			p.cancel("Cancelled.");
			return;
		}
	}

	for (const { file, targetPath } of targets) {
		if (existsSync(targetPath) && opts.backup !== false) {
			copyCredentialBackup(targetPath, backupPath(targetPath));
		}
		writeAtomic(targetPath, file.content, credentialFileMode());
	}

	if (!opts.json) {
		console.log(
			chalk.green(
				`✓ Materialized ${targets.length} credential file${targets.length === 1 ? "" : "s"} for ${tool}/${profile}`,
			),
		);
	}
}
