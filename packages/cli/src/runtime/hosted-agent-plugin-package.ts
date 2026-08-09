import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
	lstatSync,
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createGunzip } from "node:zlib";
import * as tar from "tar";
import { z } from "zod";
import type { GithubArchiveFetcher } from "../lib/github-skill-archive";
import {
	hasAsciiControlCharacter,
	parseCanonicalGithubRepositoryUrl,
	readBoundedResponseBytes,
} from "../lib/github-skill-archive";
import type { RuntimeManifest } from "./manifest-contract";
import {
	AGENT_PLUGINS_SCHEMA_1_0_0,
	agentPluginNameSchema,
	type HostedAgentPluginInstallation,
	hostedAgentPluginInstallationSchema,
} from "./manifest-resources";
import type { RuntimePaths } from "./paths";
import { makeRuntimeUserOwned, withRuntimeUserFileAccess } from "./runtime-user-command";
import { writeRuntimePlatformFileAtomic } from "./state";

export const AGENT_PLUGIN_SECRET_BINDINGS_UNSUPPORTED_ERROR =
	"Agent Plugin secret bindings are not supported by native runtimes";
export const HERMES_AGENT_PLUGIN_REMOTE_UNSUPPORTED_ERROR =
	"Hermes Agent Plugins support only Skills and stdio MCP servers";
export const HERMES_AGENT_PLUGIN_GIT_TRANSPORT_UNSUPPORTED_ERROR =
	"Hermes Agent Plugin package cannot preserve its verified bytes through local Git transport";

const CACHE_SCHEMA = "clawdi.hostedAgentPluginArchive.v1";
const RECEIPT_SCHEMA = "clawdi.hostedAgentPluginReceipts.v1";
const AGENT_PLUGINS_MCP_SCHEMA_1_0_0 = "https://agent-plugins.org/schemas/1.0.0/mcp.schema.json";
const MAX_ARCHIVE_BYTES = 100 * 1024 * 1024;
const MAX_EXPANDED_ARCHIVE_BYTES = 256 * 1024 * 1024;
const MAX_ENTRIES = 2_000;
const MAX_FILES = 1_000;
const MAX_TOTAL_FILE_BYTES = 50 * 1024 * 1024;
const MAX_FILE_BYTES = 10 * 1024 * 1024;
const MAX_PATH_BYTES = 512;
const MAX_PLUGIN_MANIFEST_BYTES = 256 * 1024;
const MAX_RECEIPT_BYTES = 4 * 1024 * 1024;
const MAX_CACHE_RECEIPT_BYTES = 4 * 1024;

export type HostedAgentPluginRuntime = "openclaw" | "hermes";

const receiptInstallationSchema = hostedAgentPluginInstallationSchema
	.omit({ secretRefs: true })
	.extend({ ownershipIdentity: z.string().regex(/^[a-f0-9]{64}$/) })
	.strict();

const hostedAgentPluginReceiptSchema = z
	.object({
		schemaVersion: z.literal(RECEIPT_SCHEMA),
		runtime: z.enum(["openclaw", "hermes"]),
		installations: z.record(agentPluginNameSchema, receiptInstallationSchema),
	})
	.strict();

export type HostedAgentPluginReceipt = z.infer<typeof hostedAgentPluginReceiptSchema>;
export type HostedAgentPluginReceiptInstallation = z.infer<typeof receiptInstallationSchema>;

export interface PreparedAgentPluginTreeFile {
	path: string;
	mode: 0o100644 | 0o100755;
	bytes: Buffer;
}

export interface PreparedHostedAgentPlugin {
	name: string;
	installation: HostedAgentPluginReceiptInstallation;
	tree: readonly PreparedAgentPluginTreeFile[];
}

export interface PreparedHostedAgentPlugins {
	runtime: HostedAgentPluginRuntime;
	desired: ReadonlyMap<string, PreparedHostedAgentPlugin>;
	previousReceipt: HostedAgentPluginReceipt | null;
	rollback: ReadonlyMap<string, PreparedHostedAgentPlugin>;
}

interface PackageDescriptor {
	name: string;
	runtime: HostedAgentPluginRuntime;
	installation: HostedAgentPluginReceiptInstallation;
}

const cacheReceiptSchema = z
	.object({
		schemaVersion: z.literal(CACHE_SCHEMA),
		ownershipIdentity: z.string().regex(/^[a-f0-9]{64}$/),
		archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();
const jsonObjectSchema = z.record(z.string(), z.unknown());

function sha256(value: string | Uint8Array): string {
	return createHash("sha256").update(value).digest("hex");
}

function ownershipIdentity(
	name: string,
	installation: Omit<HostedAgentPluginInstallation, "secretRefs">,
): string {
	return sha256(
		JSON.stringify([
			installation.installationId,
			name,
			installation.version,
			installation.agentPluginsSchema,
			installation.source.type,
			installation.source.url,
			installation.source.path,
			installation.source.commit,
			installation.contentDigest,
		]),
	);
}

function receiptInstallation(
	name: string,
	installation: HostedAgentPluginInstallation,
): HostedAgentPluginReceiptInstallation {
	const { secretRefs: _secretRefs, ...descriptor } = installation;
	return receiptInstallationSchema.parse({
		...descriptor,
		ownershipIdentity: ownershipIdentity(name, descriptor),
	});
}

export function hostedAgentPluginReceiptsPath(paths: RuntimePaths): string {
	return join(paths.statusRoot, "runtime-agent-plugin-receipts.json");
}

export function readHostedAgentPluginReceipt(paths: RuntimePaths): HostedAgentPluginReceipt | null {
	const path = hostedAgentPluginReceiptsPath(paths);
	let stat: ReturnType<typeof lstatSync>;
	try {
		stat = lstatSync(path);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return null;
		throw new Error("Agent Plugin receipts could not be inspected");
	}
	if (!stat.isFile() || stat.isSymbolicLink() || stat.size > MAX_RECEIPT_BYTES) {
		throw new Error("Agent Plugin receipts are not a trusted regular file");
	}
	if ((stat.mode & 0o777) !== 0o600) {
		throw new Error("Agent Plugin receipts do not have private file permissions");
	}
	if (typeof process.getuid === "function" && stat.uid !== process.getuid()) {
		throw new Error("Agent Plugin receipts do not have the expected file owner");
	}
	try {
		const parsed: unknown = JSON.parse(readFileSync(path, "utf8"));
		return hostedAgentPluginReceiptSchema.parse(parsed);
	} catch {
		throw new Error("Agent Plugin receipts do not match the expected schema");
	}
}

export function writeHostedAgentPluginReceipt(
	receipt: HostedAgentPluginReceipt | null,
	paths: RuntimePaths,
): void {
	const path = hostedAgentPluginReceiptsPath(paths);
	if (!receipt || Object.keys(receipt.installations).length === 0) {
		rmSync(path, { force: true });
		return;
	}
	const parsed = hostedAgentPluginReceiptSchema.parse(receipt);
	const current = readHostedAgentPluginReceipt(paths);
	if (current && JSON.stringify(current) === JSON.stringify(parsed)) return;
	writeRuntimePlatformFileAtomic(paths, path, `${JSON.stringify(parsed, null, 2)}\n`, {
		mode: 0o600,
		dirMode: 0o755,
	});
	const persisted = readHostedAgentPluginReceipt(paths);
	if (JSON.stringify(persisted) !== JSON.stringify(parsed)) {
		throw new Error("Agent Plugin receipts did not pass post-write verification");
	}
}

function cachePaths(paths: RuntimePaths, ownership: string) {
	const root = join(paths.cacheRoot, "agent-plugins", ownership);
	return { archive: join(root, "source.tar.gz"), receipt: join(root, "receipt.json") };
}

function readCachedArchive(paths: RuntimePaths, ownership: string): Buffer | null {
	const cache = cachePaths(paths, ownership);
	try {
		const archiveStat = lstatSync(cache.archive);
		const receiptStat = lstatSync(cache.receipt);
		if (
			!archiveStat.isFile() ||
			archiveStat.isSymbolicLink() ||
			archiveStat.size > MAX_ARCHIVE_BYTES ||
			(archiveStat.mode & 0o777) !== 0o600 ||
			!receiptStat.isFile() ||
			receiptStat.isSymbolicLink() ||
			receiptStat.size > MAX_CACHE_RECEIPT_BYTES ||
			(receiptStat.mode & 0o777) !== 0o600 ||
			(typeof process.getuid === "function" &&
				(archiveStat.uid !== process.getuid() || receiptStat.uid !== process.getuid()))
		) {
			return null;
		}
		const parsed: unknown = JSON.parse(readFileSync(cache.receipt, "utf8"));
		const receipt = cacheReceiptSchema.parse(parsed);
		const archive = readFileSync(cache.archive);
		if (receipt.ownershipIdentity !== ownership || sha256(archive) !== receipt.archiveSha256) {
			return null;
		}
		return archive;
	} catch {
		return null;
	}
}

function writeCachedArchive(paths: RuntimePaths, ownership: string, archive: Buffer): void {
	const cache = cachePaths(paths, ownership);
	const archiveSha256 = sha256(archive);
	writeRuntimePlatformFileAtomic(paths, cache.archive, archive, { mode: 0o600, dirMode: 0o700 });
	writeRuntimePlatformFileAtomic(
		paths,
		cache.receipt,
		`${JSON.stringify(
			{ schemaVersion: CACHE_SCHEMA, ownershipIdentity: ownership, archiveSha256 },
			null,
			2,
		)}\n`,
		{ mode: 0o600, dirMode: 0o700 },
	);
}

function safeRelativePath(path: string): boolean {
	const segments = path.split("/");
	return (
		path.length > 0 &&
		Buffer.byteLength(path, "utf8") <= MAX_PATH_BYTES &&
		!hasAsciiControlCharacter(path) &&
		!path.includes("\\") &&
		segments.every((segment) => segment && segment !== "." && segment !== "..")
	);
}

function isRegularTarEntry(type: string | undefined): boolean {
	return type === "File" || type === "OldFile" || type === "ContiguousFile";
}

async function assertExpandedArchiveLimit(bytes: Buffer): Promise<void> {
	await new Promise<void>((resolvePromise, reject) => {
		let expanded = 0;
		let settled = false;
		const gunzip = createGunzip();
		const fail = (error: Error) => {
			if (settled) return;
			settled = true;
			gunzip.destroy();
			reject(error);
		};
		gunzip.on("error", fail);
		gunzip.on("data", (chunk: Buffer) => {
			expanded += chunk.length;
			if (expanded > MAX_EXPANDED_ARCHIVE_BYTES) {
				fail(new Error("Agent Plugin repository archive exceeds the expansion limit"));
			}
		});
		gunzip.on("end", () => {
			if (settled) return;
			settled = true;
			resolvePromise();
		});
		gunzip.end(bytes);
	});
}

async function extractPackageArchive(
	root: string,
	archive: Buffer,
	sourcePath: string,
): Promise<string> {
	await assertExpandedArchiveLimit(archive);
	let archiveRoot: string | null = null;
	let entries = 0;
	let files = 0;
	let totalBytes = 0;
	await new Promise<void>((resolvePromise, reject) => {
		const stream = tar.extract({
			cwd: root,
			gzip: true,
			filter: (archivePath, entry) => {
				const segments = archivePath.replace(/\/$/, "").split("/");
				if (
					archivePath.startsWith("/") ||
					archivePath.includes("\\") ||
					segments.some(
						(segment) => segment === "." || segment === ".." || hasAsciiControlCharacter(segment),
					)
				) {
					throw new Error("Agent Plugin repository archive contains an unsafe path");
				}
				const rootSegment = segments[0];
				if (!rootSegment) return false;
				if (archiveRoot === null) archiveRoot = rootSegment;
				if (archiveRoot !== rootSegment) {
					throw new Error("Agent Plugin repository archive has multiple roots");
				}
				const repositoryPath = segments.slice(1).join("/");
				if (repositoryPath !== sourcePath && !repositoryPath.startsWith(`${sourcePath}/`)) {
					return false;
				}
				const relative = repositoryPath.slice(sourcePath.length).replace(/^\//, "");
				if (relative && !safeRelativePath(relative)) {
					throw new Error("Agent Plugin package contains an unsafe path");
				}
				entries += 1;
				if (entries > MAX_ENTRIES) throw new Error("Agent Plugin package exceeds 2000 entries");
				const type = "type" in entry ? entry.type : undefined;
				if (type !== "Directory" && !isRegularTarEntry(type)) {
					throw new Error("Agent Plugin package contains a non-regular entry");
				}
				if (isRegularTarEntry(type)) {
					files += 1;
					if (files > MAX_FILES) throw new Error("Agent Plugin package exceeds 1000 files");
					if (!Number.isSafeInteger(entry.size) || entry.size < 0 || entry.size > MAX_FILE_BYTES) {
						throw new Error("Agent Plugin package file exceeds 10 MiB");
					}
					totalBytes += entry.size;
					if (totalBytes > MAX_TOTAL_FILE_BYTES) {
						throw new Error("Agent Plugin package exceeds 50 MiB");
					}
				}
				return true;
			},
		});
		stream.on("close", resolvePromise);
		stream.on("error", reject);
		stream.end(archive);
	});
	if (!archiveRoot) throw new Error("Agent Plugin repository archive is empty");
	const packageRoot = join(root, archiveRoot, ...sourcePath.split("/"));
	if (!existsSync(packageRoot) || !lstatSync(packageRoot).isDirectory()) {
		throw new Error("Agent Plugin package path does not exist in the pinned source");
	}
	return packageRoot;
}

function collectPackageTree(packageRoot: string): {
	digest: string;
	tree: PreparedAgentPluginTreeFile[];
} {
	const tree: PreparedAgentPluginTreeFile[] = [];
	const foldedPaths = new Set<string>();
	let entries = 0;
	let totalBytes = 0;
	const visit = (directory: string, prefix: string): void => {
		for (const name of readdirSync(directory).sort((left, right) =>
			Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
		)) {
			const relative = prefix ? `${prefix}/${name}` : name;
			if (!safeRelativePath(relative))
				throw new Error("Agent Plugin package contains an unsafe path");
			const folded = relative.normalize("NFC").toLowerCase();
			if (foldedPaths.has(folded)) {
				throw new Error("Agent Plugin package contains a case-fold path collision");
			}
			foldedPaths.add(folded);
			entries += 1;
			if (entries > MAX_ENTRIES) throw new Error("Agent Plugin package exceeds 2000 entries");
			const path = join(directory, name);
			const stat = lstatSync(path);
			if (stat.isDirectory() && !stat.isSymbolicLink()) {
				visit(path, relative);
				continue;
			}
			if (!stat.isFile() || stat.isSymbolicLink()) {
				throw new Error("Agent Plugin package contains a non-regular entry");
			}
			if (tree.length >= MAX_FILES) throw new Error("Agent Plugin package exceeds 1000 files");
			if (stat.size > MAX_FILE_BYTES) throw new Error("Agent Plugin package file exceeds 10 MiB");
			totalBytes += stat.size;
			if (totalBytes > MAX_TOTAL_FILE_BYTES) throw new Error("Agent Plugin package exceeds 50 MiB");
			const bytes = readFileSync(path);
			if (bytes.length !== stat.size) throw new Error("Agent Plugin package changed while reading");
			tree.push({
				path: relative,
				mode: (stat.mode & 0o111) !== 0 ? 0o100755 : 0o100644,
				bytes,
			});
		}
	};
	visit(packageRoot, "");
	tree.sort((left, right) =>
		Buffer.compare(Buffer.from(left.path, "utf8"), Buffer.from(right.path, "utf8")),
	);
	const digest = createHash("sha256");
	for (const file of tree) {
		digest.update(
			`${file.mode.toString(8)}\0${file.path}\0${file.bytes.length}\0${sha256(file.bytes)}\n`,
			"utf8",
		);
	}
	return { digest: `sha256-tree-v1:${digest.digest("hex")}`, tree };
}

function parseJsonObject(
	file: PreparedAgentPluginTreeFile | undefined,
	label: string,
): Record<string, unknown> {
	if (!file) throw new Error(`${label} must be a regular file at the package root`);
	if (file.bytes.length > MAX_PLUGIN_MANIFEST_BYTES) throw new Error(`${label} is too large`);
	try {
		const parsed: unknown = JSON.parse(
			new TextDecoder("utf-8", { fatal: true }).decode(file.bytes),
		);
		return jsonObjectSchema.parse(parsed);
	} catch {
		throw new Error(`${label} must be a valid JSON object`);
	}
}

function assertPackageIdentity(
	descriptor: PackageDescriptor,
	tree: readonly PreparedAgentPluginTreeFile[],
): void {
	const manifest = parseJsonObject(
		tree.find((file) => file.path === "plugin.json"),
		"Agent Plugin plugin.json",
	);
	if (
		manifest.$schema !== AGENT_PLUGINS_SCHEMA_1_0_0 ||
		manifest.$schema !== descriptor.installation.agentPluginsSchema ||
		manifest.name !== descriptor.name ||
		manifest.version !== descriptor.installation.version
	) {
		throw new Error("Agent Plugin package identity does not match the desired installation");
	}
}

function assertHermesSupportedPackage(tree: readonly PreparedAgentPluginTreeFile[]): void {
	for (const file of tree) {
		const segments = file.path.split("/").map((segment) => segment.toLowerCase());
		if (segments.includes(".git") || segments.at(-1) === ".gitattributes") {
			throw new Error(HERMES_AGENT_PLUGIN_GIT_TRANSPORT_UNSUPPORTED_ERROR);
		}
	}
	const mcpFile = tree.find((file) => file.path === "mcp.json");
	if (!mcpFile) return;
	const mcp = parseJsonObject(mcpFile, "Agent Plugin mcp.json");
	const servers = mcp.mcpServers;
	if (
		mcp.$schema !== AGENT_PLUGINS_MCP_SCHEMA_1_0_0 ||
		typeof servers !== "object" ||
		servers === null ||
		Array.isArray(servers)
	) {
		throw new Error(HERMES_AGENT_PLUGIN_REMOTE_UNSUPPORTED_ERROR);
	}
	for (const server of Object.values(servers)) {
		if (typeof server !== "object" || server === null || Array.isArray(server)) {
			throw new Error(HERMES_AGENT_PLUGIN_REMOTE_UNSUPPORTED_ERROR);
		}
		const type = "type" in server ? server.type : undefined;
		if (type !== "stdio") throw new Error(HERMES_AGENT_PLUGIN_REMOTE_UNSUPPORTED_ERROR);
	}
}

async function validateArchive(
	archive: Buffer,
	descriptor: PackageDescriptor,
): Promise<PreparedHostedAgentPlugin> {
	const root = mkdtempSync(join(tmpdir(), "clawdi-agent-plugin-validate-"));
	try {
		const packageRoot = await extractPackageArchive(
			root,
			archive,
			descriptor.installation.source.path,
		);
		const collected = collectPackageTree(packageRoot);
		if (collected.digest !== descriptor.installation.contentDigest) {
			throw new Error(
				"Agent Plugin package content digest does not match the desired installation",
			);
		}
		assertPackageIdentity(descriptor, collected.tree);
		if (descriptor.runtime === "hermes") assertHermesSupportedPackage(collected.tree);
		return { name: descriptor.name, installation: descriptor.installation, tree: collected.tree };
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

async function fetchArchive(
	descriptor: PackageDescriptor,
	fetcher: GithubArchiveFetcher,
): Promise<Buffer> {
	const repository = parseCanonicalGithubRepositoryUrl(descriptor.installation.source.url);
	const url = new URL(
		`https://codeload.github.com/${encodeURIComponent(repository.owner)}/${encodeURIComponent(repository.repo)}/tar.gz/${encodeURIComponent(descriptor.installation.source.commit)}`,
	);
	const response = await fetcher(url, {
		headers: { Accept: "application/vnd.github+json" },
		redirect: "follow",
	});
	if (!response.ok) throw new Error(`Agent Plugin package download failed (${response.status})`);
	return readBoundedResponseBytes(response, MAX_ARCHIVE_BYTES, {
		resourceLabel: "Agent Plugin repository archive",
		limitLabel: "100 MB",
	});
}

async function preparePackage(
	descriptor: PackageDescriptor,
	paths: RuntimePaths,
	fetcher: GithubArchiveFetcher,
): Promise<PreparedHostedAgentPlugin> {
	const cached = readCachedArchive(paths, descriptor.installation.ownershipIdentity);
	if (cached) {
		try {
			return await validateArchive(cached, descriptor);
		} catch {
			// A corrupt or stale private cache is never authority; refetch the immutable source.
		}
	}
	const archive = await fetchArchive(descriptor, fetcher);
	const prepared = await validateArchive(archive, descriptor);
	writeCachedArchive(paths, descriptor.installation.ownershipIdentity, archive);
	return prepared;
}

function selectedAgentPluginRuntime(manifest: RuntimeManifest): HostedAgentPluginRuntime {
	if (manifest.runtime === "openclaw" || manifest.runtime === "hermes") return manifest.runtime;
	throw new Error("Agent Plugins require a selected OpenClaw or Hermes runtime");
}

export async function prepareHostedAgentPluginPackages(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	options: { fetcher?: GithubArchiveFetcher } = {},
): Promise<PreparedHostedAgentPlugins | null> {
	const desiredInstallations = manifest.projection?.agentPlugins?.installations ?? {};
	for (const installation of Object.values(desiredInstallations)) {
		if (Object.keys(installation.secretRefs).length > 0) {
			throw new Error(AGENT_PLUGIN_SECRET_BINDINGS_UNSUPPORTED_ERROR);
		}
	}
	const previousReceipt = readHostedAgentPluginReceipt(paths);
	if (Object.keys(desiredInstallations).length === 0 && !previousReceipt) return null;
	const runtime =
		Object.keys(desiredInstallations).length > 0
			? selectedAgentPluginRuntime(manifest)
			: previousReceipt?.runtime;
	if (!runtime) return null;
	const fetcher = options.fetcher ?? fetch;
	const preparedPackages = new Map<string, Promise<PreparedHostedAgentPlugin>>();
	const load = (descriptor: PackageDescriptor): Promise<PreparedHostedAgentPlugin> => {
		const ownership = descriptor.installation.ownershipIdentity;
		const key = `${descriptor.runtime}\0${ownership}`;
		const existing = preparedPackages.get(key);
		if (existing) return existing;
		const pending = preparePackage(descriptor, paths, fetcher);
		preparedPackages.set(key, pending);
		return pending;
	};

	const desired = new Map<string, PreparedHostedAgentPlugin>();
	for (const [name, installation] of Object.entries(desiredInstallations).sort(([left], [right]) =>
		left.localeCompare(right),
	)) {
		const descriptor = receiptInstallation(name, installation);
		desired.set(name, await load({ name, runtime, installation: descriptor }));
	}
	const rollback = new Map<string, PreparedHostedAgentPlugin>();
	if (previousReceipt) {
		for (const [name, installation] of Object.entries(previousReceipt.installations).sort(
			([left], [right]) => left.localeCompare(right),
		)) {
			const { ownershipIdentity: persistedOwnership, ...descriptor } = installation;
			if (persistedOwnership !== ownershipIdentity(name, descriptor)) {
				throw new Error("Agent Plugin receipt ownership identity is invalid");
			}
			rollback.set(name, await load({ name, runtime: previousReceipt.runtime, installation }));
		}
	}
	return { runtime, desired, previousReceipt, rollback };
}

export function withPreparedAgentPluginDirectory<T>(
	prepared: PreparedHostedAgentPlugin,
	operation: (sourceDir: string) => T,
): T {
	const root = mkdtempSync(join(tmpdir(), "clawdi-agent-plugin-stage-"));
	try {
		chmodSync(root, 0o700);
		makeRuntimeUserOwned(root);
		const sourceDir = join(root, "package");
		withRuntimeUserFileAccess(() => {
			mkdirSync(sourceDir, { recursive: true, mode: 0o700 });
			for (const file of prepared.tree) {
				const target = join(sourceDir, ...file.path.split("/"));
				mkdirSync(dirname(target), { recursive: true, mode: 0o700 });
				writeFileSync(target, file.bytes, { mode: file.mode & 0o777 });
			}
		});
		return operation(sourceDir);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}
