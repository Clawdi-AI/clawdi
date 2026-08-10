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
import { validateHeaderName, validateHeaderValue } from "node:http";
import { isIP } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { createGunzip } from "node:zlib";
import * as tar from "tar";
import { parseDocument } from "yaml";
import { z } from "zod";
import type { GithubArchiveFetcher } from "../lib/github-skill-archive";
import {
	hasAsciiControlCharacter,
	parseCanonicalGithubRepositoryUrl,
	readBoundedResponseBytes,
} from "../lib/github-skill-archive";
import { AGENT_PLUGIN_HOSTED_V2_REQUIRED_ERROR, type RuntimeManifest } from "./manifest-contract";
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
	"Hermes remote Agent Plugin components cannot be proven through the native CLI";
export const HERMES_AGENT_PLUGIN_GIT_TRANSPORT_UNSUPPORTED_ERROR =
	"Hermes Agent Plugin package cannot preserve its verified bytes through local Git transport";

const CACHE_SCHEMA = "clawdi.hostedAgentPluginArchive.v1";
const RECEIPT_SCHEMA = "clawdi.hostedAgentPluginReceipts.v2";
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
const PLACEHOLDER_PREFIX = "$";
const PLUGIN_ROOT = `${PLACEHOLDER_PREFIX}{PLUGIN_ROOT}`;
const PLUGIN_DATA = `${PLACEHOLDER_PREFIX}{PLUGIN_DATA}`;

export type HostedAgentPluginRuntime = "openclaw" | "hermes";

const preparedInstallationSchema = hostedAgentPluginInstallationSchema
	.omit({ secretRefs: true })
	.extend({ ownershipIdentity: z.string().regex(/^[a-f0-9]{64}$/) })
	.strict();
const nativePluginIdSchema = z
	.string()
	.min(1)
	.max(128)
	.regex(/^[A-Za-z0-9](?:[A-Za-z0-9._-]*[A-Za-z0-9])?$/);
const receiptInstallationSchema = preparedInstallationSchema
	.extend({ nativeId: nativePluginIdSchema })
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
export type PreparedHostedAgentPluginInstallation = z.infer<typeof preparedInstallationSchema>;

export interface PreparedAgentPluginTreeFile {
	path: string;
	mode: 0o100644 | 0o100755;
	bytes: Buffer;
}

export interface PreparedHostedAgentPlugin {
	name: string;
	installation: PreparedHostedAgentPluginInstallation;
	receiptNativeId: string | null;
	mcpServerNames: readonly string[];
	tree: readonly PreparedAgentPluginTreeFile[];
}

export interface PreparedHostedAgentPlugins {
	runtime: HostedAgentPluginRuntime;
	desired: ReadonlyMap<string, PreparedHostedAgentPlugin>;
	previousReceipt: HostedAgentPluginReceipt | null;
	rollback: ReadonlyMap<string, PreparedHostedAgentPlugin>;
	transientCacheOwnerships: ReadonlySet<string>;
}

interface PackageDescriptor {
	name: string;
	runtime: HostedAgentPluginRuntime;
	installation: PreparedHostedAgentPluginInstallation;
}

const cacheReceiptSchema = z
	.object({
		schemaVersion: z.literal(CACHE_SCHEMA),
		ownershipIdentity: z.string().regex(/^[a-f0-9]{64}$/),
		archiveSha256: z.string().regex(/^[a-f0-9]{64}$/),
	})
	.strict();
const jsonObjectSchema = z.record(z.string(), z.unknown());
const pluginManifestSchema = z
	.object({
		$schema: z.literal(AGENT_PLUGINS_SCHEMA_1_0_0),
		name: agentPluginNameSchema,
		version: z.string().optional(),
		description: z.string().optional(),
		author: z
			.object({
				name: z.string().optional(),
				email: z.string().optional(),
				url: z.string().optional(),
			})
			.strict()
			.optional(),
		homepage: z.string().optional(),
		repository: z.string().optional(),
		license: z.string().optional(),
		keywords: z.array(z.string()).optional(),
		extensions: z.record(z.string(), z.record(z.string(), z.unknown())).optional(),
	})
	.strict();
const stdioServerSchema = z
	.object({
		type: z.literal("stdio"),
		command: z.string().min(1),
		args: z.array(z.string()).optional(),
		env: z.record(z.string(), z.string()).optional(),
		cwd: z.string().optional(),
	})
	.strict();
const remoteServerSchema = z
	.object({
		type: z.enum(["streamable-http", "sse"]),
		url: z.string().min(1),
		headers: z.record(z.string(), z.string()).optional(),
	})
	.strict();
const mcpManifestSchema = z
	.object({
		$schema: z.literal(AGENT_PLUGINS_MCP_SCHEMA_1_0_0),
		mcpServers: z.record(z.string().min(1), z.union([stdioServerSchema, remoteServerSchema])),
	})
	.strict();

// Unicode 15.0 full case-fold mappings that differ from JavaScript lowercase,
// excluding Cherokee, which is handled by its compact contiguous ranges below.
// Source: https://www.unicode.org/Public/15.0.0/ucd/CaseFolding.txt (C/F rows).
function parseCaseFoldOverride(entry: string): readonly [number, string] {
	const [source, target = ""] = entry.split(":");
	return [
		Number.parseInt(source ?? "", 16),
		target
			.split(",")
			.map((codePoint) => String.fromCodePoint(Number.parseInt(codePoint, 16)))
			.join(""),
	];
}

const CASE_FOLD_OVERRIDES = new Map<number, string>(
	"b5:3bc;df:73,73;149:2bc,6e;17f:73;1f0:6a,30c;345:3b9;390:3b9,308,301;3b0:3c5,308,301;3c2:3c3;3d0:3b2;3d1:3b8;3d5:3c6;3d6:3c0;3f0:3ba;3f1:3c1;3f5:3b5;587:565,582;1c80:432;1c81:434;1c82:43e;1c83:441;1c84:442;1c85:442;1c86:44a;1c87:463;1c88:a64b;1e96:68,331;1e97:74,308;1e98:77,30a;1e99:79,30a;1e9a:61,2be;1e9b:1e61;1e9e:73,73;1f50:3c5,313;1f52:3c5,313,300;1f54:3c5,313,301;1f56:3c5,313,342;1f80:1f00,3b9;1f81:1f01,3b9;1f82:1f02,3b9;1f83:1f03,3b9;1f84:1f04,3b9;1f85:1f05,3b9;1f86:1f06,3b9;1f87:1f07,3b9;1f88:1f00,3b9;1f89:1f01,3b9;1f8a:1f02,3b9;1f8b:1f03,3b9;1f8c:1f04,3b9;1f8d:1f05,3b9;1f8e:1f06,3b9;1f8f:1f07,3b9;1f90:1f20,3b9;1f91:1f21,3b9;1f92:1f22,3b9;1f93:1f23,3b9;1f94:1f24,3b9;1f95:1f25,3b9;1f96:1f26,3b9;1f97:1f27,3b9;1f98:1f20,3b9;1f99:1f21,3b9;1f9a:1f22,3b9;1f9b:1f23,3b9;1f9c:1f24,3b9;1f9d:1f25,3b9;1f9e:1f26,3b9;1f9f:1f27,3b9;1fa0:1f60,3b9;1fa1:1f61,3b9;1fa2:1f62,3b9;1fa3:1f63,3b9;1fa4:1f64,3b9;1fa5:1f65,3b9;1fa6:1f66,3b9;1fa7:1f67,3b9;1fa8:1f60,3b9;1fa9:1f61,3b9;1faa:1f62,3b9;1fab:1f63,3b9;1fac:1f64,3b9;1fad:1f65,3b9;1fae:1f66,3b9;1faf:1f67,3b9;1fb2:1f70,3b9;1fb3:3b1,3b9;1fb4:3ac,3b9;1fb6:3b1,342;1fb7:3b1,342,3b9;1fbc:3b1,3b9;1fbe:3b9;1fc2:1f74,3b9;1fc3:3b7,3b9;1fc4:3ae,3b9;1fc6:3b7,342;1fc7:3b7,342,3b9;1fcc:3b7,3b9;1fd2:3b9,308,300;1fd3:3b9,308,301;1fd6:3b9,342;1fd7:3b9,308,342;1fe2:3c5,308,300;1fe3:3c5,308,301;1fe4:3c1,313;1fe6:3c5,342;1fe7:3c5,308,342;1ff2:1f7c,3b9;1ff3:3c9,3b9;1ff4:3ce,3b9;1ff6:3c9,342;1ff7:3c9,342,3b9;1ffc:3c9,3b9;fb00:66,66;fb01:66,69;fb02:66,6c;fb03:66,66,69;fb04:66,66,6c;fb05:73,74;fb06:73,74;fb13:574,576;fb14:574,565;fb15:574,56b;fb16:57e,576;fb17:574,56d"
		.split(";")
		.map(parseCaseFoldOverride),
);

function unicodeCaseFold(value: string): string {
	let folded = "";
	for (const character of value) {
		const codePoint = character.codePointAt(0);
		if (codePoint === undefined) continue;
		const override = CASE_FOLD_OVERRIDES.get(codePoint);
		if (override !== undefined) {
			folded += override;
		} else if (
			(codePoint >= 0x13a0 && codePoint <= 0x13f5) ||
			(codePoint >= 0x13f8 && codePoint <= 0x13fd) ||
			(codePoint >= 0xab70 && codePoint <= 0xabbf)
		) {
			folded += character.toUpperCase();
		} else {
			folded += character.toLowerCase();
		}
	}
	return folded;
}

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

function preparedInstallation(
	name: string,
	installation: HostedAgentPluginInstallation,
): PreparedHostedAgentPluginInstallation {
	const { secretRefs: _secretRefs, ...descriptor } = installation;
	return preparedInstallationSchema.parse({
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

function cacheContainer(paths: RuntimePaths): string {
	return join(paths.cacheRoot, "agent-plugins");
}

function cacheOwnershipExists(paths: RuntimePaths, ownership: string): boolean {
	try {
		lstatSync(dirname(cachePaths(paths, ownership).archive));
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}

function removeCacheOwnership(
	paths: RuntimePaths,
	ownership: string,
	options: { allowIncomplete?: boolean } = {},
): boolean {
	if (!/^[a-f0-9]{64}$/.test(ownership)) return false;
	const container = cacheContainer(paths);
	const target = join(container, ownership);
	if (dirname(target) !== container) return false;
	try {
		const containerStat = lstatSync(container);
		if (!containerStat.isDirectory() || containerStat.isSymbolicLink()) return false;
		const targetStat = lstatSync(target);
		if (!targetStat.isDirectory() || targetStat.isSymbolicLink()) return false;
		const entries = readdirSync(target);
		if (options.allowIncomplete !== true && readCachedArchive(paths, ownership) === null) {
			return false;
		}
		for (const entry of entries) {
			if (entry !== "source.tar.gz" && entry !== "receipt.json") return false;
			const entryStat = lstatSync(join(target, entry));
			if (!entryStat.isFile() || entryStat.isSymbolicLink()) return false;
		}
		rmSync(target, { recursive: true });
		return true;
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
		throw error;
	}
}

function assertCacheOwnershipWritable(paths: RuntimePaths, ownership: string): void {
	const { archive } = cachePaths(paths, ownership);
	const target = dirname(archive);
	try {
		const stat = lstatSync(target);
		if (!stat.isDirectory() || stat.isSymbolicLink()) {
			throw new Error("Agent Plugin cache ownership path is not a trusted directory");
		}
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
		throw error;
	}
}

export function cleanupHostedAgentPluginTransientArchives(
	prepared: PreparedHostedAgentPlugins | null,
	paths: RuntimePaths,
): void {
	if (!prepared) return;
	for (const ownership of prepared.transientCacheOwnerships) {
		removeCacheOwnership(paths, ownership, { allowIncomplete: true });
	}
}

export function gcHostedAgentPluginArchives(
	receipt: HostedAgentPluginReceipt | null,
	paths: RuntimePaths,
): void {
	const keep = new Set(
		Object.values(receipt?.installations ?? {}).map(
			(installation) => installation.ownershipIdentity,
		),
	);
	const container = cacheContainer(paths);
	let entries: string[];
	try {
		const stat = lstatSync(container);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return;
		entries = readdirSync(container);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
		throw error;
	}
	for (const entry of entries) {
		if (/^[a-f0-9]{64}$/.test(entry) && !keep.has(entry)) removeCacheOwnership(paths, entry);
	}
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
	assertCacheOwnershipWritable(paths, ownership);
	const cache = cachePaths(paths, ownership);
	const archiveSha256 = sha256(archive);
	try {
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
	} catch (error) {
		removeCacheOwnership(paths, ownership, { allowIncomplete: true });
		throw error;
	}
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
				if (
					sourcePath !== "" &&
					repositoryPath !== sourcePath &&
					!repositoryPath.startsWith(`${sourcePath}/`)
				) {
					return false;
				}
				const relative =
					sourcePath === ""
						? repositoryPath
						: repositoryPath.slice(sourcePath.length).replace(/^\//, "");
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

function collectPackageTree(
	packageRoot: string,
	options: { ignoreTopLevelGitMetadata?: boolean } = {},
): {
	digest: string;
	tree: PreparedAgentPluginTreeFile[];
} {
	const packageRootStat = lstatSync(packageRoot);
	if (!packageRootStat.isDirectory() || packageRootStat.isSymbolicLink()) {
		throw new Error("Agent Plugin package root is not a trusted directory");
	}
	const tree: PreparedAgentPluginTreeFile[] = [];
	const foldedPaths = new Set<string>();
	let entries = 0;
	let totalBytes = 0;
	const visit = (directory: string, prefix: string): void => {
		for (const name of readdirSync(directory).sort((left, right) =>
			Buffer.compare(Buffer.from(left, "utf8"), Buffer.from(right, "utf8")),
		)) {
			if (options.ignoreTopLevelGitMetadata && prefix === "" && name === ".git") continue;
			const relative = prefix ? `${prefix}/${name}` : name;
			if (!safeRelativePath(relative))
				throw new Error("Agent Plugin package contains an unsafe path");
			const folded = unicodeCaseFold(relative);
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

export function hostedAgentPluginDirectoryDigest(
	packageRoot: string,
	options: { ignoreTopLevelGitMetadata?: boolean } = {},
): string {
	return collectPackageTree(packageRoot, options).digest;
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

function decodeUtf8(file: PreparedAgentPluginTreeFile, label: string): string {
	try {
		return new TextDecoder("utf-8", { fatal: true }).decode(file.bytes);
	} catch {
		throw new Error(`${label} must be valid UTF-8`);
	}
}

function assertSkillComponents(tree: readonly PreparedAgentPluginTreeFile[]): void {
	const skillFiles = tree.filter((file) => file.path.startsWith("skills/"));
	const skillNames = new Set<string>();
	for (const file of skillFiles) {
		const segments = file.path.split("/");
		const skillName = segments[1];
		if (!skillName || !/^[a-z0-9]+(?:-[a-z0-9]+)*$/.test(skillName) || segments.length < 3) {
			throw new Error("Agent Plugin contains an invalid Skill path");
		}
		skillNames.add(skillName);
	}
	for (const skillName of skillNames) {
		const file = tree.find((entry) => entry.path === `skills/${skillName}/SKILL.md`);
		if (!file) throw new Error("Agent Plugin Skill is missing SKILL.md");
		const raw = decodeUtf8(file, "Agent Plugin SKILL.md").replace(/^\uFEFF/, "");
		const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\s*\r?\n|$)/);
		if (!match) throw new Error("Agent Plugin SKILL.md has invalid frontmatter");
		const document = parseDocument(match[1] ?? "", { uniqueKeys: true });
		if (document.errors.length > 0) {
			throw new Error("Agent Plugin SKILL.md has invalid frontmatter");
		}
		const frontmatter = z
			.object({
				name: z.string().min(1).max(64),
				description: z.string().min(1).max(1_024),
				license: z.string().optional(),
				compatibility: z.string().min(1).max(500).optional(),
				metadata: z.record(z.string(), z.string()).optional(),
				"allowed-tools": z.string().optional(),
			})
			.passthrough()
			.safeParse(document.toJS());
		if (!frontmatter.success || frontmatter.data.name !== skillName) {
			throw new Error("Agent Plugin SKILL.md frontmatter does not match its Skill directory");
		}
	}
}

function assertScopedPortablePath(value: string): void {
	let relativePath: string;
	if (value.startsWith("./")) relativePath = value.slice(2);
	else if (value === PLUGIN_ROOT || value === PLUGIN_DATA) return;
	else if (value.startsWith(`${PLUGIN_ROOT}/`)) relativePath = value.slice(PLUGIN_ROOT.length + 1);
	else if (value.startsWith(`${PLUGIN_DATA}/`)) relativePath = value.slice(PLUGIN_DATA.length + 1);
	else throw new Error("Agent Plugin MCP path is outside the portable package boundary");
	if (!safeRelativePath(relativePath)) {
		throw new Error("Agent Plugin MCP path is outside the portable package boundary");
	}
}

function explicitUrlHostname(value: string): string | null {
	const schemeEnd = value.indexOf("://");
	if (schemeEnd < 0) return null;
	const remainder = value.slice(schemeEnd + 3);
	const authorityEnd = remainder.search(/[/?#]/);
	const authority = authorityEnd < 0 ? remainder : remainder.slice(0, authorityEnd);
	if (!authority) return null;
	if (authority.startsWith("[")) {
		const close = authority.indexOf("]");
		if (close < 0 || !/^(?::[0-9]+)?$/.test(authority.slice(close + 1))) return null;
		return authority.slice(1, close);
	}
	const colon = authority.lastIndexOf(":");
	if (colon < 0) return authority;
	if (authority.indexOf(":") !== colon || !/^[0-9]+$/.test(authority.slice(colon + 1))) {
		return null;
	}
	return authority.slice(0, colon);
}

function isExplicitLoopbackHostname(value: string): boolean {
	const hostname = explicitUrlHostname(value)?.toLowerCase();
	if (!hostname) return false;
	return (
		hostname === "localhost" ||
		hostname === "::1" ||
		hostname === "0:0:0:0:0:0:0:1" ||
		(isIP(hostname) === 4 && hostname.split(".")[0] === "127")
	);
}

function assertRemoteServer(server: z.infer<typeof remoteServerSchema>): void {
	let url: URL;
	try {
		url = new URL(server.url);
	} catch {
		throw new Error("Agent Plugin remote MCP URL is invalid");
	}
	if (
		(url.protocol !== "https:" && url.protocol !== "http:") ||
		url.username !== "" ||
		url.password !== "" ||
		url.hash !== "" ||
		!url.hostname
	) {
		throw new Error("Agent Plugin remote MCP URL is invalid");
	}
	if (url.protocol === "http:") {
		if (!isExplicitLoopbackHostname(server.url)) {
			throw new Error("Agent Plugin remote MCP URL must use HTTPS");
		}
	}
	const headerNames = new Set<string>();
	for (const [name, value] of Object.entries(server.headers ?? {})) {
		const foldedName = name.toLowerCase();
		try {
			validateHeaderName(name);
			validateHeaderValue(name, value);
		} catch {
			throw new Error("Agent Plugin remote MCP headers are invalid");
		}
		if (headerNames.has(foldedName)) {
			throw new Error("Agent Plugin remote MCP headers are invalid");
		}
		headerNames.add(foldedName);
	}
}

function assertMcpComponents(
	tree: readonly PreparedAgentPluginTreeFile[],
	runtime: HostedAgentPluginRuntime,
): string[] {
	const file = tree.find((entry) => entry.path === "mcp.json");
	if (!file) return [];
	const parsed = mcpManifestSchema.safeParse(parseJsonObject(file, "Agent Plugin mcp.json"));
	if (!parsed.success) throw new Error("Agent Plugin mcp.json does not match the 1.0.0 schema");
	for (const server of Object.values(parsed.data.mcpServers)) {
		if (server.type !== "stdio") {
			assertRemoteServer(server);
			if (runtime === "hermes") throw new Error(HERMES_AGENT_PLUGIN_REMOTE_UNSUPPORTED_ERROR);
			continue;
		}
		if (
			server.command.includes("\0") ||
			(!server.command.startsWith("./") &&
				(/[\s/\\]/u.test(server.command) || server.command === "." || server.command === ".."))
		) {
			throw new Error("Agent Plugin stdio MCP command is invalid");
		}
		if (server.command.startsWith("./")) assertScopedPortablePath(server.command);
		if ((server.args ?? []).some((value) => value.includes("\0"))) {
			throw new Error("Agent Plugin stdio MCP args are invalid");
		}
		for (const [name, value] of Object.entries(server.env ?? {})) {
			if (
				name === "PLUGIN_ROOT" ||
				name === "PLUGIN_DATA" ||
				name.includes("\0") ||
				value.includes("\0")
			) {
				throw new Error("Agent Plugin stdio MCP environment is invalid");
			}
		}
		if (server.cwd !== undefined) assertScopedPortablePath(server.cwd);
	}
	return Object.keys(parsed.data.mcpServers).sort();
}

function assertPackageIdentity(
	descriptor: PackageDescriptor,
	tree: readonly PreparedAgentPluginTreeFile[],
): void {
	const manifest = pluginManifestSchema.safeParse(
		parseJsonObject(
			tree.find((file) => file.path === "plugin.json"),
			"Agent Plugin plugin.json",
		),
	);
	if (
		!manifest.success ||
		manifest.data.$schema !== descriptor.installation.agentPluginsSchema ||
		manifest.data.name !== descriptor.name ||
		manifest.data.version !== descriptor.installation.version
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
		assertSkillComponents(collected.tree);
		const mcpServerNames = assertMcpComponents(collected.tree, descriptor.runtime);
		if (descriptor.runtime === "hermes") assertHermesSupportedPackage(collected.tree);
		return {
			name: descriptor.name,
			installation: descriptor.installation,
			receiptNativeId: null,
			mcpServerNames,
			tree: collected.tree,
		};
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
	offline: boolean,
	receiptOwned: boolean,
): Promise<{ plugin: PreparedHostedAgentPlugin; cacheCreated: boolean }> {
	const cached = readCachedArchive(paths, descriptor.installation.ownershipIdentity);
	if (cached) {
		try {
			return { plugin: await validateArchive(cached, descriptor), cacheCreated: false };
		} catch (error) {
			if (offline) throw new Error("offline Agent Plugin cache is invalid");
			if (receiptOwned) throw error;
		}
	}
	if (offline) {
		throw new Error(
			cacheOwnershipExists(paths, descriptor.installation.ownershipIdentity)
				? "offline Agent Plugin cache is invalid"
				: "offline Agent Plugin cache is missing",
		);
	}
	if (
		cacheOwnershipExists(paths, descriptor.installation.ownershipIdentity) &&
		!removeCacheOwnership(paths, descriptor.installation.ownershipIdentity)
	) {
		throw new Error("Agent Plugin cache ownership path is not a managed cache entry");
	}
	const archive = await fetchArchive(descriptor, fetcher);
	const prepared = await validateArchive(archive, descriptor);
	writeCachedArchive(paths, descriptor.installation.ownershipIdentity, archive);
	return { plugin: prepared, cacheCreated: true };
}

function selectedAgentPluginRuntime(manifest: RuntimeManifest): HostedAgentPluginRuntime {
	if (manifest.runtime === "openclaw" || manifest.runtime === "hermes") return manifest.runtime;
	throw new Error("Agent Plugins require a selected OpenClaw or Hermes runtime");
}

export async function prepareHostedAgentPluginPackages(
	manifest: RuntimeManifest,
	paths: RuntimePaths,
	options: { fetcher?: GithubArchiveFetcher; offline?: boolean } = {},
): Promise<PreparedHostedAgentPlugins | null> {
	const desiredInstallations = manifest.projection?.agentPlugins?.installations ?? {};
	const isHostedV2 = manifest.projection?.sourceBundleVersion === "clawdi.hosted-runtime.bundle.v2";
	if (!isHostedV2) {
		if (Object.keys(desiredInstallations).length > 0) {
			throw new Error(AGENT_PLUGIN_HOSTED_V2_REQUIRED_ERROR);
		}
		return null;
	}
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
	const preparedPackages = new Map<
		string,
		Promise<{ plugin: PreparedHostedAgentPlugin; cacheCreated: boolean }>
	>();
	const createdOwnerships = new Set<string>();
	const previousOwnerships = new Set(
		Object.values(previousReceipt?.installations ?? {}).map(
			(installation) => installation.ownershipIdentity,
		),
	);
	const load = async (descriptor: PackageDescriptor): Promise<PreparedHostedAgentPlugin> => {
		const ownership = descriptor.installation.ownershipIdentity;
		const key = `${descriptor.runtime}\0${ownership}`;
		const existing = preparedPackages.get(key);
		if (existing) return (await existing).plugin;
		const pending = preparePackage(
			descriptor,
			paths,
			fetcher,
			options.offline === true,
			previousOwnerships.has(ownership),
		);
		preparedPackages.set(key, pending);
		const result = await pending;
		if (result.cacheCreated) createdOwnerships.add(ownership);
		return result.plugin;
	};
	try {
		const desired = new Map<string, PreparedHostedAgentPlugin>();
		for (const [name, installation] of Object.entries(desiredInstallations).sort(
			([left], [right]) => left.localeCompare(right),
		)) {
			const descriptor = preparedInstallation(name, installation);
			desired.set(name, await load({ name, runtime, installation: descriptor }));
		}
		const rollback = new Map<string, PreparedHostedAgentPlugin>();
		if (previousReceipt) {
			for (const [name, installation] of Object.entries(previousReceipt.installations).sort(
				([left], [right]) => left.localeCompare(right),
			)) {
				const { ownershipIdentity: persistedOwnership, nativeId, ...descriptor } = installation;
				if (persistedOwnership !== ownershipIdentity(name, descriptor)) {
					throw new Error("Agent Plugin receipt ownership identity is invalid");
				}
				const plugin = await load({
					name,
					runtime: previousReceipt.runtime,
					installation: preparedInstallationSchema.parse({
						...descriptor,
						ownershipIdentity: persistedOwnership,
					}),
				});
				rollback.set(name, { ...plugin, receiptNativeId: nativeId });
			}
		}
		return {
			runtime,
			desired,
			previousReceipt,
			rollback,
			transientCacheOwnerships: new Set(
				[...createdOwnerships].filter((ownership) => !previousOwnerships.has(ownership)),
			),
		};
	} catch (error) {
		for (const ownership of createdOwnerships) {
			if (!previousOwnerships.has(ownership)) {
				removeCacheOwnership(paths, ownership, { allowIncomplete: true });
			}
		}
		throw error;
	}
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
