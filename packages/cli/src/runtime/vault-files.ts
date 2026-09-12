import { spawnSync } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import {
	chmodSync,
	closeSync,
	constants,
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
import {
	withPrivateDirectoryLock,
	withPrivateDirectoryLockSync,
} from "../lib/private-directory-lock";
import { writePrivateFileAtomic } from "../lib/private-file";
import { assertTrustedDirectory, ensureDirectoryWithinTrustedRoot } from "../lib/trusted-directory";
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
				content_version: z.number().int().nonnegative(),
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
	content_version: z.number().int().nonnegative(),
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
		userId: z.uuid().optional(),
		machineId: z.string().optional(),
		nativeAgentId: z.string().optional(),
		directory: z.literal(".clawdi/vaults"),
		digests: z.record(generatedName, z.string().regex(/^[a-f0-9]{64}$/)),
		apiUrl: z.string(),
		agentId: z.uuid(),
		workspace: z.string(),
		device: z.number(),
		inode: z.number(),
		files: z.array(generatedName),
		// Incomplete owned cache metadata is refreshed from the current API.
		inventory: z.array(indexVaultSchema.partial({ content_version: true })),
		etag: z.string().nullable(),
	})
	.strict();
type Receipt = z.infer<typeof receiptSchema>;

export type RuntimeVaultFilesConfig = {
	apiUrl: string;
	agentId: string;
	home: string;
	workspace: string;
	receiptPath: string;
} & (
	| {
			paths: RuntimePaths;
			apiKey: string;
			connected?: undefined;
	  }
	| {
			paths?: undefined;
			apiKey?: undefined;
			connected: {
				userId: string;
				machineId: string;
				nativeAgentId?: string;
				stateRoot: string;
				assertCurrent(): void;
				request(url: string, init: RequestInit): Promise<Response>;
			};
	  }
);

// Filesystem cleanup needs identity and ownership, never credentials or network callbacks.
type VaultFileContext = Omit<RuntimeVaultFilesConfig, "connected" | "apiKey"> & {
	connected?: Pick<
		NonNullable<RuntimeVaultFilesConfig["connected"]>,
		"userId" | "machineId" | "nativeAgentId" | "stateRoot"
	>;
};

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
			const stat = fstatSync(next);
			if (
				(stat.uid !== 0 && stat.uid !== process.geteuid?.()) ||
				((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)
			) {
				closeSync(next);
				fail();
			}
			closeSync(fd);
			fd = next;
		}
		return fd;
	} catch {
		closeSync(fd);
		return fail();
	}
}
type VaultDirectory = { fd: number; path: string; connected: boolean };

function assertConnectedDirectory(path: string): void {
	if (!isAbsolute(path) || resolve(path) !== path) fail();
	let current = "/";
	for (const part of path.split("/").filter(Boolean)) {
		current = join(current, part);
		assertTrustedDirectory(current);
		const stat = lstatSync(current);
		if (
			(stat.uid !== 0 && stat.uid !== process.geteuid?.()) ||
			((stat.mode & 0o022) !== 0 && (stat.mode & 0o1000) === 0)
		)
			fail();
	}
}

function filePath(directory: VaultDirectory, name: string): string {
	if (!directory.connected) return `/proc/self/fd/${directory.fd}/${name}`;
	assertConnectedDirectory(directory.path);
	const named = lstatSync(directory.path),
		opened = fstatSync(directory.fd);
	if (
		named.dev !== opened.dev ||
		named.ino !== opened.ino ||
		named.uid !== process.geteuid?.() ||
		(named.mode & 0o777) !== 0o700
	)
		fail();
	return join(directory.path, name);
}
function verifyFile(directory: VaultDirectory, name: string): boolean {
	const path = filePath(directory, name);
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
function fileDigest(directory: VaultDirectory, name: string): string | null {
	if (!verifyFile(directory, name)) return null;
	const file = openSync(filePath(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = fstatSync(file);
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > 16 * 1024 * 1024) fail();
		return createHash("sha256").update(readFileSync(file)).digest("hex");
	} finally {
		closeSync(file);
	}
}
function atomicFile(directory: VaultDirectory, name: string, content: string): void {
	if (verifyFile(directory, name)) {
		const existing = openSync(filePath(directory, name), constants.O_RDONLY | constants.O_NOFOLLOW);
		try {
			const stat = fstatSync(existing);
			if (!stat.isFile() || stat.nlink !== 1) fail();
			if (readFileSync(existing, "utf8") === content) return;
		} finally {
			closeSync(existing);
		}
	}
	if (directory.connected) {
		writePrivateFileAtomic(filePath(directory, name), content, {
			mode: 0o600,
			durable: true,
			trustedRoot: directory.path,
		});
		verifyFile(directory, name);
		return;
	}
	const temp = filePath(directory, `.clawdi-${randomUUID()}`);
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
		renameSync(temp, filePath(directory, name));
		fsyncSync(directory.fd);
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
function saveReceipt(config: VaultFileContext, receipt: Receipt): void {
	const content = `${JSON.stringify(receipt)}\n`;
	if (config.connected) {
		writePrivateFileAtomic(config.receiptPath, content, {
			mode: 0o600,
			dirMode: 0o700,
			durable: true,
			trustedRoot: config.connected.stateRoot,
		});
	} else {
		if (!config.paths) fail();
		writeRuntimePlatformFileAtomic(config.paths, config.receiptPath, content, { mode: 0o600 });
	}
}
function readReceiptFile(path: string): Receipt | null {
	let fd: number;
	try {
		fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT")
			return null;
		return fail();
	}
	try {
		const stat = fstatSync(fd);
		if (
			!stat.isFile() ||
			stat.nlink !== 1 ||
			stat.uid !== process.geteuid?.() ||
			(stat.mode & 0o777) !== 0o600 ||
			stat.size > 16 * 1024 * 1024
		)
			fail();
		const parsed = receiptSchema.safeParse(JSON.parse(readFileSync(fd, "utf8")));
		if (!parsed.success) fail();
		return parsed.data;
	} finally {
		closeSync(fd);
	}
}
function readReceipt(config: VaultFileContext): Receipt | null {
	const receipt = readReceiptFile(config.receiptPath);
	if (!receipt) return null;
	if (
		receipt.apiUrl !== config.apiUrl ||
		receipt.agentId !== config.agentId ||
		receipt.workspace !== config.workspace ||
		receipt.userId !== config.connected?.userId ||
		receipt.machineId !== config.connected?.machineId ||
		receipt.nativeAgentId !== config.connected?.nativeAgentId
	)
		fail();
	return receipt;
}
function withVaultFileAccess<T>(
	config: VaultFileContext,
	operation: () => T & (T extends PromiseLike<unknown> ? never : unknown),
): T {
	return config.connected ? operation() : withRuntimeUserFileAccess(operation);
}

function withDirectory<T>(
	config: VaultFileContext,
	receipt: Receipt,
	operation: (directory: VaultDirectory) => T & (T extends PromiseLike<unknown> ? never : unknown),
): T {
	return withVaultFileAccess(config, () => {
		const path = join(config.workspace, ".clawdi/vaults");
		if (config.connected) assertConnectedDirectory(path);
		const fd = config.connected
			? openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
			: openDirectory(path);
		try {
			const stat = fstatSync(fd);
			if (
				stat.dev !== receipt.device ||
				stat.ino !== receipt.inode ||
				stat.uid !== process.geteuid?.() ||
				(stat.mode & 0o777) !== 0o700
			)
				fail();
			return operation({ fd, path, connected: Boolean(config.connected) });
		} finally {
			closeSync(fd);
		}
	});
}
function checkTracked(config: VaultFileContext): void {
	// Even absent working-tree files may be tracked. Git failure is not proof of absence.
	const runGit = (args: string[]) =>
		config.connected
			? spawnSync("git", args, {
					cwd: config.workspace,
					encoding: "utf8",
					timeout: 5000,
					maxBuffer: 1024 * 1024,
				})
			: spawnRuntimeUserCommand("git", args, config.home, config.workspace, {
					timeoutMs: 5000,
					maxBufferBytes: 1024 * 1024,
				});
	const git = runGit(["-C", config.workspace, "rev-parse", "--show-toplevel"]);
	if (git.status === 0) {
		const tracked = runGit(["-C", config.workspace, "ls-files", "--", ".clawdi/vaults"]);
		if (tracked.status !== 0 || String(tracked.stdout).trim()) fail();
	} else if (!String(git.stderr).includes("not a git repository")) fail();
}
function initialize(config: VaultFileContext): Receipt {
	const within = relative(config.home, config.workspace);
	if (!config.connected && (within === ".." || within.startsWith("../") || isAbsolute(within)))
		fail();
	checkTracked(config);
	const identity = withVaultFileAccess(config, () => {
		if (config.connected) {
			assertConnectedDirectory(config.workspace);
			const parent = join(config.workspace, ".clawdi");
			ensureDirectoryWithinTrustedRoot(config.workspace, parent, { mode: 0o700 });
			assertConnectedDirectory(parent);
			if ((lstatSync(parent).mode & 0o022) !== 0) fail();
			const path = join(parent, "vaults");
			// EEXIST still requires operator repair without the private receipt.
			mkdirSync(path, { mode: 0o700 });
			chmodSync(path, 0o700); // Only the directory just created by this writer.
			const fd = openSync(path, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW);
			try {
				const stat = fstatSync(fd);
				return { device: stat.dev, inode: stat.ino };
			} finally {
				closeSync(fd);
			}
		}
		const workspace = openDirectory(config.workspace);
		try {
			try {
				mkdirSync(`/proc/self/fd/${workspace}/.clawdi`, { mode: 0o700 });
			} catch (error) {
				if (!(error && typeof error === "object" && "code" in error && error.code === "EEXIST"))
					throw error;
			}
			const parent = openSync(
				`/proc/self/fd/${workspace}/.clawdi`,
				constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
			);
			try {
				const parentStat = fstatSync(parent);
				if (
					(parentStat.uid !== process.geteuid?.() && parentStat.uid !== 0) ||
					(parentStat.mode & 0o022) !== 0
				)
					fail();
				// Existing .clawdi is shared with other features; only vaults is runtime-owned.
				// Missing receipt after mkdir requires operator repair; do not adopt an arbitrary directory.
				mkdirSync(`/proc/self/fd/${parent}/vaults`, { mode: 0o700 });
				const fd = openSync(
					`/proc/self/fd/${parent}/vaults`,
					constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW,
				);
				try {
					const stat = fstatSync(fd);
					return { device: stat.dev, inode: stat.ino };
				} finally {
					closeSync(fd);
				}
			} finally {
				closeSync(parent);
			}
		} finally {
			closeSync(workspace);
		}
	});
	const receipt: Receipt = {
		version: 1,
		directory: ".clawdi/vaults",
		...(config.connected
			? {
					userId: config.connected.userId,
					machineId: config.connected.machineId,
					nativeAgentId: config.connected.nativeAgentId,
				}
			: {}),
		digests: {},
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
function revoke(config: VaultFileContext, receipt: Receipt | null): "revoked" {
	if (receipt) {
		checkTracked(config);
		withDirectory(config, receipt, (fd) => {
			for (const name of receipt.files) if (verifyFile(fd, name)) unlinkSync(filePath(fd, name));
			fsyncSync(fd.fd);
		});
		saveReceipt(config, { ...receipt, files: [], inventory: [], digests: {}, etag: null });
	}
	return "revoked";
}
function pruneRevoked(
	config: VaultFileContext,
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
		fsyncSync(fd.fd);
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
			return { ...old, content_version: vault.content_version };
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
			content_version: vault.content_version,
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

export function connectedVaultFilesSupported(): boolean {
	return process.platform === "linux" || process.platform === "darwin";
}

function connectedLockPath(stateRoot: string): string {
	assertConnectedDirectory(stateRoot);
	const root = join(stateRoot, "vault-file-lock");
	ensureDirectoryWithinTrustedRoot(stateRoot, root, { mode: 0o700 });
	const stat = lstatSync(root);
	if (stat.uid !== process.geteuid?.() || (stat.mode & 0o777) !== 0o700) fail();
	const lock = join(root, "writer");
	try {
		const entry = lstatSync(lock);
		if (!entry.isDirectory() || entry.isSymbolicLink()) fail();
	} catch (error) {
		if (!(error && typeof error === "object" && "code" in error && error.code === "ENOENT"))
			throw error;
	}
	return lock;
}

export function clearConnectedVaultFiles(
	...args: Parameters<typeof clearConnectedVaultFilesLocked>
): void {
	if (!connectedVaultFilesSupported()) fail();
	try {
		lstatSync(args[0]);
	} catch (error) {
		if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return;
		throw error;
	}
	// Never block the event loop behind an in-flight async writer. The controller retries after it settles.
	withPrivateDirectoryLockSync(
		connectedLockPath(args[1]),
		() => clearConnectedVaultFilesLocked(...args),
		{ timeoutMs: 0 },
	);
}

/** Local registration/auth revocation removes only the private receipt's generated files. */
function clearConnectedVaultFilesLocked(
	receiptPath: string,
	stateRoot: string,
	home: string,
	expected?: {
		userId: string;
		machineId: string;
		nativeAgentId?: string;
		agentId: string;
		workspace: string;
		apiUrl: string;
	},
	clearMatching = false,
): void {
	const receipt = readReceiptFile(receiptPath);
	if (!receipt) return;
	if (!receipt.userId || !receipt.machineId) fail();
	const matches = Boolean(
		expected &&
			receipt.userId === expected.userId &&
			receipt.machineId === expected.machineId &&
			receipt.agentId === expected.agentId &&
			receipt.workspace === expected.workspace &&
			receipt.apiUrl === expected.apiUrl &&
			receipt.nativeAgentId === expected.nativeAgentId,
	);
	if (clearMatching ? !matches : matches) return;
	revoke(
		{
			apiUrl: receipt.apiUrl,
			agentId: receipt.agentId,
			workspace: receipt.workspace,
			home,
			receiptPath,
			connected: {
				userId: receipt.userId,
				machineId: receipt.machineId,
				nativeAgentId: receipt.nativeAgentId,
				stateRoot,
			},
		},
		receipt,
	);
	if (expected && !clearMatching) {
		if (receipt.workspace === expected.workspace) {
			// Explicit setup can rebind a proven, now-empty generated directory.
			writePrivateFileAtomic(
				receiptPath,
				`${JSON.stringify({ ...receipt, ...expected, files: [], inventory: [], digests: {}, etag: null })}\n`,
				{ mode: 0o600, dirMode: 0o700, durable: true, trustedRoot: stateRoot },
			);
		} else unlinkSync(receiptPath);
	}
}

export async function syncRuntimeVaultFiles(
	input: RuntimeVaultFilesConfig,
): Promise<"unchanged" | "synced" | "revoked" | "deferred"> {
	if (input.connected ? !connectedVaultFilesSupported() : process.platform !== "linux") {
		throw new Error("Connected Vault files require macOS or Linux; Hosted requires Linux.");
	}
	if (!input.connected) return syncVaultSnapshot(input);
	const connected = input.connected;
	try {
		return await withPrivateDirectoryLock(connectedLockPath(connected.stateRoot), (lease) =>
			syncVaultSnapshot({
				...input,
				connected: {
					...connected,
					assertCurrent() {
						lease.assertOwned();
						connected.assertCurrent();
					},
				},
			}),
		);
	} catch {
		return fail();
	}
}

/** Secrets never enter logs, tool results, native manifests or the root receipt. */
async function syncVaultSnapshot(
	input: RuntimeVaultFilesConfig,
): Promise<"unchanged" | "synced" | "revoked" | "deferred"> {
	try {
		const config = { ...input, apiUrl: normalizeCloudApiBaseUrl(input.apiUrl) };
		config.connected?.assertCurrent();
		const request = config.connected?.request ?? fetch;
		if (!config.connected && !config.apiKey) fail();
		const query = config.connected ? `?agent_id=${encodeURIComponent(config.agentId)}` : "";
		let receipt = readReceipt(config);
		const intact =
			receipt &&
			withDirectory(config, receipt, (fd) =>
				receipt?.files.every((name) => fileDigest(fd, name) === receipt?.digests[name]),
			);
		// Refresh incomplete cached metadata while reusing intact, owned values.
		const etag =
			intact && receipt?.inventory.every((vault) => vault.content_version !== undefined)
				? receipt.etag
				: null;
		const response = await request(`${config.apiUrl}/v1/runtime/vaults${query}`, {
			headers: {
				...(config.connected ? {} : { Authorization: `Bearer ${config.apiKey}` }),
				...(etag ? { "If-None-Match": etag } : {}),
			},
			redirect: "error",
			signal: AbortSignal.timeout(10000),
		});
		config.connected?.assertCurrent();
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
		config.connected?.assertCurrent();
		if (
			metadata.agent_id !== config.agentId ||
			(config.connected && metadata.user_id !== config.connected.userId)
		)
			fail();
		receipt = pruneRevoked(config, receipt, metadata);
		const material = await request(`${config.apiUrl}/v1/runtime/vaults/material${query}`, {
			method: "POST",
			redirect: "error",
			signal: AbortSignal.timeout(10000),
			headers: {
				...(config.connected ? {} : { Authorization: `Bearer ${config.apiKey}` }),
				"Content-Type": "application/json",
			},
			body: JSON.stringify({
				etag: response.headers.get("etag"),
				revisions: intact
					? Object.fromEntries(
							(receipt?.inventory ?? []).map((vault) => [vault.id, vault.revision]),
						)
					: {},
			}),
		});
		config.connected?.assertCurrent();
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
		config.connected?.assertCurrent();
		const { files, inventory, names } = render(snapshot, intact ? receipt : null);
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
			fsyncSync(fd.fd);
		});
		saveReceipt(config, {
			...receipt,
			files: names,
			digests: Object.fromEntries(
				names.map((name) => [
					name,
					files.has(name)
						? createHash("sha256")
								.update(files.get(name) ?? "")
								.digest("hex")
						: receipt.digests[name],
				]),
			),
			inventory,
			etag: response.headers.get("etag"),
		});
		return "synced";
	} catch {
		return fail();
	}
}
