import { copyFileSync, existsSync, mkdirSync, renameSync, statSync, writeFileSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { basename, dirname, join, resolve } from "node:path";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { getCodexHome } from "../adapters/paths";
import { ApiClient } from "../lib/api-client";
import { getAuth, getConfig, isLoggedIn } from "../lib/config";
import { resolveProjectId } from "../lib/project-resolver";

const MAX_PROFILE_FILE_BYTES = 1024 * 1024;

type TargetStrategy = "adapter_default" | "explicit";

interface CredentialFileSnapshot {
	logicalName: string;
	sourcePath: string;
	targetPath?: string;
	targetStrategy: TargetStrategy;
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
	from?: string;
	to?: string;
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

function codexDefaultPlan(from?: string, to?: string): FilePlan[] {
	const sourcePath = resolve(expandHome(from ?? join(getCodexHome(), "auth.json")));
	return [
		{
			logicalName: "auth.json",
			sourcePath,
			targetPath: to ? resolve(expandHome(to)) : undefined,
			targetStrategy: to ? "explicit" : "adapter_default",
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
		},
	];
}

function buildImportPlan(tool: string, opts: ImportOptions): FilePlan[] {
	if (tool === "codex") return codexDefaultPlan(opts.from, opts.to);
	if (!opts.from) {
		throw new Error(
			`No built-in credential adapter for "${tool}". Pass --from <path> to import an explicit credential file.`,
		);
	}
	return explicitFilePlan(tool, opts.from, opts.to);
}

function adapterTargetPath(tool: string, logicalName: string): string | null {
	if (tool === "codex" && logicalName === "auth.json") {
		return join(getCodexHome(), "auth.json");
	}
	return null;
}

async function snapshotFile(plan: FilePlan): Promise<CredentialFileSnapshot> {
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
		content,
		mode: stat.mode & 0o777,
		size: stat.size,
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
		files.push({
			logicalName: entry.logicalName,
			sourcePath: entry.sourcePath,
			targetPath,
			targetStrategy: entry.targetStrategy,
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

function backupPath(path: string): string {
	const timestamp = new Date().toISOString().replace(/[-:]/g, "").replace(/\..+$/, "Z");
	return `${path}.bak-${timestamp}`;
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
	const tool = normalizeName(toolInput, "tool");
	const profile = normalizeName(opts.profile ?? "default", "profile", 120);
	const plan = buildImportPlan(tool, opts);
	const files = await Promise.all(plan.map(snapshotFile));
	const envelope = buildEnvelope(tool, profile, files);

	const preview = previewFiles(
		files.map((file) => ({
			logicalName: file.logicalName,
			sourcePath: file.sourcePath,
			targetPath: file.targetPath ?? adapterTargetPath(tool, file.logicalName) ?? undefined,
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
					files: files.map((file) => ({
						logical_name: file.logicalName,
						source_path: file.sourcePath,
						target_path: file.targetPath ?? adapterTargetPath(tool, file.logicalName),
						size: file.size,
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

	if (!opts.yes) {
		const ok = await p.confirm({ message: "Import this credential profile into Clawdi Vault?" });
		if (p.isCancel(ok) || !ok) {
			p.cancel("Cancelled.");
			return;
		}
	}

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
	const tool = normalizeName(toolInput, "tool");
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
			copyFileSync(targetPath, backupPath(targetPath));
		}
		writeAtomic(targetPath, file.content, file.mode);
	}

	if (!opts.json) {
		console.log(
			chalk.green(
				`✓ Materialized ${targets.length} credential file${targets.length === 1 ? "" : "s"} for ${tool}/${profile}`,
			),
		);
	}
}
