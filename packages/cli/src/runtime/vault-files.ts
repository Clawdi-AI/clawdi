import { createHash, randomUUID } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdirSync,
	openSync,
	readFileSync,
	renameSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { isAbsolute, join, relative, resolve } from "node:path";
import type { components } from "@clawdi/shared/api";
import { z } from "zod";
import { normalizeCloudApiBaseUrl } from "../lib/api-origin";
import type { RuntimePaths } from "./paths";
import { spawnRuntimeUserCommand, withRuntimeUserFileAccess } from "./runtime-user-command";
import { writeRuntimePlatformFileAtomic } from "./state";

const snapshotSchema = z.object({
	schema_version: z.literal(1),
	complete: z.literal(true),
	agent_id: z.uuid(),
	user_id: z.uuid(),
	vaults: z
		.array(
			z.object({
				id: z.uuid(),
				name: z.string(),
				slug: z.string(),
				project_ids: z.array(z.uuid()).min(1),
				revision: z.string(),
				fields: z
					.array(
						z.object({
							id: z.uuid(),
							section: z.string(),
							name: z.string(),
							references: z.array(z.string().startsWith("clawdi://")),
							value: z.string(),
						}),
					)
					.nullable(),
			}),
		)
		.max(10000),
}) satisfies z.ZodType<components["schemas"]["RuntimeVaultSnapshot"]>;
type Snapshot = z.infer<typeof snapshotSchema>;
const generatedName = z
	.string()
	.regex(/^(?:\.gitignore|(?:index|[a-f0-9-]{36}-[a-f0-9]{64})\.json)$/);
const indexVaultSchema = z.object({
	id: z.uuid(),
	name: z.string(),
	slug: z.string(),
	project_ids: z.array(z.uuid()),
	revision: z.string(),
	sections: z.array(
		z.object({
			id: z.string(),
			name: z.string(),
			file: generatedName,
			fields: z.array(
				z.object({
					id: z.uuid(),
					name: z.string(),
					references: z.array(z.string()),
					env_name: z.string().nullable(),
				}),
			),
		}),
	),
});
const receiptSchema = z
	.object({
		version: z.literal(1),
		apiUrl: z.string(),
		agentId: z.uuid(),
		workspace: z.string(),
		device: z.number(),
		inode: z.number(),
		files: z.array(generatedName),
		inventory: z.array(indexVaultSchema),
		etag: z.string().nullable(),
	})
	.strict();
type Receipt = z.infer<typeof receiptSchema>;

export interface RuntimeVaultFilesConfig {
	apiUrl: string;
	apiKey: string;
	agentId: string;
	home: string;
	workspace: string;
	receiptPath: string;
	paths: RuntimePaths;
}

function fail(): never {
	throw new Error(
		"Runtime Vault files could not be synchronized; last good files retained where possible.",
	);
}

/** Pin every ancestor without following links; all tenant IO runs with tenant credentials. */
function openDirectory(path: string): number {
	if (!isAbsolute(path) || resolve(path) !== path) fail();
	let fd = openSync("/", constants.O_RDONLY | constants.O_DIRECTORY);
	try {
		for (const part of path.split("/").filter(Boolean)) {
			const next = openSync(
				`/proc/self/fd/${fd}/${part}`,
				constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
			);
			closeSync(fd);
			fd = next;
		}
		return fd;
	} catch {
		closeSync(fd);
		return fail();
	}
}
function filePath(fd: number, name: string): string {
	return `/proc/self/fd/${fd}/${name}`;
}
function verifyFile(fd: number, name: string): boolean {
	const path = filePath(fd, name);
	try {
		const stat = lstatSync(path);
		if (
			!stat.isFile() ||
			stat.nlink !== 1 ||
			stat.uid !== process.geteuid?.() ||
			(stat.mode & 0o777) !== 0o600
		)
			fail();
		return true;
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
			return false;
		return fail();
	}
}
function atomicFile(fd: number, name: string, content: string): void {
	if (verifyFile(fd, name)) {
		const existing = openSync(filePath(fd, name), constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const stat = fstatSync(existing);
			if (!stat.isFile() || stat.nlink !== 1) fail();
			if (readFileSync(existing, "utf8") === content) return;
		} finally {
			closeSync(existing);
		}
	}
	const temp = filePath(fd, `.clawdi-${randomUUID()}`);
	let opened: number | undefined;
	try {
		opened = openSync(
			temp,
			constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
			0o600,
		);
		writeFileSync(opened, content);
		fsyncSync(opened);
		closeSync(opened);
		opened = undefined;
		renameSync(temp, filePath(fd, name));
		fsyncSync(fd);
	} finally {
		if (opened !== undefined) closeSync(opened);
		try {
			unlinkSync(temp);
		} catch (error) {
			if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
				fail();
		}
	}
}
function saveReceipt(config: RuntimeVaultFilesConfig, receipt: Receipt): void {
	writeRuntimePlatformFileAtomic(config.paths, config.receiptPath, `${JSON.stringify(receipt)}\n`, {
		mode: 0o600,
	});
}
function readReceipt(config: RuntimeVaultFilesConfig): Receipt | null {
	if (!existsSync(config.receiptPath)) return null;
	const result = receiptSchema.safeParse(JSON.parse(readFileSync(config.receiptPath, "utf8")));
	if (!result.success) fail();
	const receipt = result.data;
	if (
		receipt.apiUrl !== config.apiUrl ||
		receipt.agentId !== config.agentId ||
		receipt.workspace !== config.workspace
	)
		fail();
	return receipt;
}
function withDirectory<T>(
	config: RuntimeVaultFilesConfig,
	receipt: Receipt,
	operation: (fd: number) => T & (T extends PromiseLike<unknown> ? never : unknown),
): T {
	return withRuntimeUserFileAccess(() => {
		const fd = openDirectory(join(config.workspace, ".secrets"));
		try {
			const stat = fstatSync(fd);
			if (
				stat.dev !== receipt.device ||
				stat.ino !== receipt.inode ||
				stat.uid !== process.geteuid?.() ||
				(stat.mode & 0o777) !== 0o700
			)
				fail();
			return operation(fd);
		} finally {
			closeSync(fd);
		}
	});
}
function checkTracked(config: RuntimeVaultFilesConfig): void {
	// Even absent working-tree files may be tracked. Git failure is not proof of absence.
	const git = spawnRuntimeUserCommand(
		"git",
		["-C", config.workspace, "rev-parse", "--show-toplevel"],
		config.home,
		config.workspace,
		{ timeoutMs: 5000, maxBufferBytes: 1024 * 1024 },
	);
	if (git.status === 0) {
		const tracked = spawnRuntimeUserCommand(
			"git",
			["-C", config.workspace, "ls-files", "--", ".secrets"],
			config.home,
			config.workspace,
			{ timeoutMs: 5000, maxBufferBytes: 1024 * 1024 },
		);
		if (tracked.status !== 0 || String(tracked.stdout).trim()) fail();
	} else if (!String(git.stderr).includes("not a git repository")) fail();
}
function initialize(config: RuntimeVaultFilesConfig): Receipt {
	const within = relative(config.home, config.workspace);
	if (within === ".." || within.startsWith("../") || isAbsolute(within)) fail();
	checkTracked(config);
	const identity = withRuntimeUserFileAccess(() => {
		const workspace = openDirectory(config.workspace);
		try {
			// EEXIST is intentional: an unrelated .secrets must never be adopted/chmodded.
			mkdirSync(filePath(workspace, ".secrets"), { mode: 0o700 });
			const fd = openSync(
				filePath(workspace, ".secrets"),
				constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
			);
			try {
				const stat = fstatSync(fd);
				return { device: stat.dev, inode: stat.ino };
			} finally {
				closeSync(fd);
			}
		} finally {
			closeSync(workspace);
		}
	});
	const receipt: Receipt = {
		version: 1,
		apiUrl: config.apiUrl,
		agentId: config.agentId,
		workspace: config.workspace,
		...identity,
		files: [],
		inventory: [],
		etag: null,
	};
	saveReceipt(config, receipt);
	return receipt;
}
function revoke(config: RuntimeVaultFilesConfig, receipt: Receipt | null): "revoked" {
	if (receipt) {
		checkTracked(config);
		withDirectory(config, receipt, (fd) => {
			for (const name of receipt.files) if (verifyFile(fd, name)) unlinkSync(filePath(fd, name));
			fsyncSync(fd);
		});
		saveReceipt(config, { ...receipt, files: [], inventory: [], etag: null });
	}
	return "revoked";
}
function pruneRevoked(
	config: RuntimeVaultFilesConfig,
	receipt: Receipt | null,
	metadata: Snapshot,
): Receipt | null {
	if (!receipt) return null;
	const allowed = new Set(metadata.vaults.map((vault) => vault.id));
	if (allowed.size !== metadata.vaults.length) fail();
	const removed = receipt.files.filter(
		(name) => name !== "index.json" && name !== ".gitignore" && !allowed.has(name.slice(0, 36)),
	);
	if (removed.length === 0) return receipt;
	checkTracked(config);
	const inventory = receipt.inventory.filter((vault) => allowed.has(vault.id));
	withDirectory(config, receipt, (fd) => {
		for (const name of removed) if (verifyFile(fd, name)) unlinkSync(filePath(fd, name));
		atomicFile(
			fd,
			"index.json",
			`${JSON.stringify({ version: 1, agent_id: metadata.agent_id, user_id: metadata.user_id, vaults: inventory }, null, 2)}\n`,
		);
		fsyncSync(fd);
	});
	const next = {
		...receipt,
		inventory,
		files: receipt.files.filter((name) => !removed.includes(name)),
		etag: null,
	};
	saveReceipt(config, next);
	return next;
}
function render(snapshot: Snapshot, previous: Receipt | null) {
	const files = new Map<string, string>([[".gitignore", "*\n"]]);
	const vaultIds = new Set<string>();
	const index = snapshot.vaults.map((vault) => {
		if (vaultIds.has(vault.id)) fail();
		vaultIds.add(vault.id);
		if (vault.fields === null) {
			const old = previous?.inventory.find(
				(entry) => entry.id === vault.id && entry.revision === vault.revision,
			);
			if (!old) fail();
			return old;
		}
		const sections = new Map<string, NonNullable<typeof vault.fields>>();
		for (const field of vault.fields) {
			const fields = sections.get(field.section) ?? [];
			fields.push(field);
			sections.set(field.section, fields);
		}
		return {
			id: vault.id,
			name: vault.name,
			slug: vault.slug,
			project_ids: vault.project_ids,
			revision: vault.revision,
			sections: [...sections].map(([name, fields]) => {
				const id = createHash("sha256").update(name).digest("hex");
				const file = `${vault.id}-${id}.json`;
				if (new Set(fields.map((field) => field.name)).size !== fields.length) fail();
				files.set(
					file,
					`${JSON.stringify(Object.fromEntries(fields.map((field) => [field.name, field.value])))}\n`,
				);
				return {
					id,
					name,
					file,
					fields: fields.map(({ id, name, references }) => ({
						id,
						name,
						references,
						env_name: /^[A-Za-z_][A-Za-z0-9_]*$/.test(name) ? name : null,
					})),
				};
			}),
		};
	});
	if (
		index
			.flatMap((vault) => vault.sections)
			.reduce((total, section) => total + section.fields.length, 0) > 10000 ||
		Buffer.byteLength(JSON.stringify(index)) > 8 * 1024 * 1024
	)
		fail();
	files.set(
		"index.json",
		`${JSON.stringify({ version: 1, agent_id: snapshot.agent_id, user_id: snapshot.user_id, vaults: index }, null, 2)}\n`,
	);
	return {
		files,
		inventory: index,
		names: [
			".gitignore",
			"index.json",
			...index.flatMap((vault) => vault.sections.map((section) => section.file)),
		],
	};
}
async function readSnapshot(response: Response): Promise<Snapshot> {
	if (!response.body) fail();
	const reader = response.body.getReader();
	const chunks: Uint8Array[] = [];
	let size = 0;
	try {
		for (;;) {
			const { done, value } = await reader.read();
			if (done) break;
			size += value.byteLength;
			if (size > 16 * 1024 * 1024) fail();
			chunks.push(value);
		}
	} finally {
		await reader.cancel();
	}
	const parsed = snapshotSchema.safeParse(JSON.parse(Buffer.concat(chunks).toString("utf8")));
	if (!parsed.success) fail();
	return parsed.data;
}

/** Secrets never enter logs, tool results, native manifests or the root receipt. */
export async function syncRuntimeVaultFiles(
	input: RuntimeVaultFilesConfig,
): Promise<"unchanged" | "synced" | "revoked" | "deferred"> {
	try {
		const config = { ...input, apiUrl: normalizeCloudApiBaseUrl(input.apiUrl) };
		let receipt = readReceipt(config);
		const intact =
			receipt &&
			withDirectory(config, receipt, (fd) => receipt?.files.every((name) => verifyFile(fd, name)));
		const etag = intact ? receipt?.etag : null;
		const response = await fetch(`${config.apiUrl}/v1/runtime/vaults`, {
			headers: {
				Authorization: `Bearer ${config.apiKey}`,
				...(etag ? { "If-None-Match": etag } : {}),
			},
			redirect: "error",
			signal: AbortSignal.timeout(10000),
		});
		if (response.status === 304) {
			if (!etag) fail();
			return "unchanged";
		}
		if (response.status === 401 || response.status === 403) {
			await response.body?.cancel();
			return revoke(config, receipt);
		}
		if (!response.ok) {
			await response.body?.cancel();
			fail();
		}
		const metadata = await readSnapshot(response);
		if (metadata.agent_id !== config.agentId) fail();
		receipt = pruneRevoked(config, receipt, metadata);
		const material = await fetch(`${config.apiUrl}/v1/runtime/vaults/material`, {
			method: "POST",
			redirect: "error",
			signal: AbortSignal.timeout(10000),
			headers: { Authorization: `Bearer ${config.apiKey}`, "Content-Type": "application/json" },
			body: JSON.stringify({
				etag: response.headers.get("etag"),
				revisions: intact
					? Object.fromEntries(
							(receipt?.inventory ?? []).map((vault) => [vault.id, vault.revision]),
						)
					: {},
			}),
		});
		if (material.status === 401 || material.status === 403) {
			await material.body?.cancel();
			return revoke(config, receipt);
		}
		if (material.status === 409) {
			await material.body?.cancel();
			return "deferred";
		}
		if (!material.ok) {
			await material.body?.cancel();
			fail();
		}
		const snapshot = await readSnapshot(material);
		if (
			snapshot.agent_id !== config.agentId ||
			snapshot.user_id !== metadata.user_id ||
			material.headers.get("etag") !== response.headers.get("etag")
		)
			fail();
		const { files, inventory, names } = render(snapshot, receipt);
		if (receipt) checkTracked(config);
		receipt ??= initialize(config);
		withDirectory(config, receipt, (fd) => {
			for (const name of files.keys()) {
				if (!receipt?.files.includes(name) && verifyFile(fd, name)) fail();
			}
		});
		// Reserve generated names before writing: a crash can be recovered without adopting user files.
		const reserved = {
			...receipt,
			files: [...new Set([...receipt.files, ...names])],
			etag: null,
		};
		saveReceipt(config, reserved);
		withDirectory(config, reserved, (fd) => {
			for (const name of reserved.files) verifyFile(fd, name);
			for (const [name, content] of files) atomicFile(fd, name, content);
			for (const name of reserved.files)
				if (!names.includes(name) && verifyFile(fd, name)) unlinkSync(filePath(fd, name));
			fsyncSync(fd);
		});
		saveReceipt(config, {
			...receipt,
			files: names,
			inventory,
			etag: response.headers.get("etag"),
		});
		return "synced";
	} catch {
		return fail();
	}
}
