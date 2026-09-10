import { spawnSync } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import {
	closeSync,
	constants,
	existsSync,
	fstatSync,
	fsyncSync,
	lstatSync,
	mkdtempSync,
	openSync,
	readFileSync,
	realpathSync,
	renameSync,
	rmSync,
	unlinkSync,
	writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, join, resolve } from "node:path";
import { parseEnv } from "node:util";
import type { components } from "@clawdi/shared/api";
import { z } from "zod";

export type VaultMaterial = components["schemas"]["VaultMaterializeResponse"];
const MARKER = "# clawdi-vault-binding ";
const bindingSchema = z
	.object({
		version: z.literal(1),
		apiUrl: z.string().url(),
		userId: z.uuid(),
		agentId: z.uuid().optional(),
		projectId: z.uuid(),
		vaultId: z.uuid(),
		section: z.string().nullable(),
		salt: z.string().regex(/^[a-f0-9]{32}$/),
		fields: z.record(
			z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/),
			z
				.object({
					itemId: z.uuid(),
					reference: z.string().startsWith("clawdi://"),
					hash: z.string().regex(/^[a-f0-9]{64}$/),
				})
				.strict(),
		),
	})
	.strict();
export type VaultEnvBinding = z.infer<typeof bindingSchema>;

const materialSchema = z.object({
	user_id: z.uuid(),
	project_id: z.uuid(),
	vault_id: z.uuid(),
	section: z.string().nullable(),
	item_ids: z.record(z.string(), z.uuid()),
	references: z.record(z.string(), z.string().startsWith("clawdi://")),
	values: z.record(z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/), z.string()),
}) satisfies z.ZodType<VaultMaterial>;

export function validateVaultMaterial(value: unknown): VaultMaterial {
	const parsed = materialSchema.safeParse(value);
	if (!parsed.success) throw new Error("Invalid Vault material response.");
	const { values, item_ids: ids, references } = parsed.data;
	const keys = Object.keys(values);
	if (
		keys.length > 1000 ||
		keys.length !== Object.keys(ids).length ||
		keys.length !== Object.keys(references).length ||
		keys.some((key) => !Object.hasOwn(ids, key) || !Object.hasOwn(references, key))
	) {
		throw new Error("Incomplete Vault source identity.");
	}
	return parsed.data;
}

interface EnvRecord {
	name?: string;
	text: string;
}

/** Split logical assignments without rewriting unrelated comments, spacing or multiline values. */
function records(content: string): EnvRecord[] {
	const result: EnvRecord[] = [];
	let offset = 0;
	while (offset < content.length) {
		const start = offset;
		const end = content.indexOf("\n", offset);
		const lineEnd = end < 0 ? content.length : end + 1;
		const line = content.slice(offset, lineEnd);
		if (/^[ \t\r]*(?:#[^\n]*)?\n?$/.test(line)) {
			result.push({ text: line });
			offset = lineEnd;
			continue;
		}
		const match = /^[ \t]*(?:export[ \t]+)?([A-Za-z_][A-Za-z0-9_]*)[ \t]*=[ \t]*/.exec(line);
		if (!match) throw new Error("Cannot safely parse target env file; use a separate file.");
		const name = match[1];
		const valueStart = offset + match[0].length;
		const quote = content[valueStart];
		if (quote === "'" || quote === '"' || quote === "`") {
			const closing = content.indexOf(quote, valueStart + 1);
			if (closing < 0) throw new Error("Unclosed quoted value in target env file.");
			const next = content.indexOf("\n", closing + 1);
			offset = next < 0 ? content.length : next + 1;
			if (!/^[ \t\r]*(?:#[^\n]*)?\n?$/.test(content.slice(closing + 1, offset))) {
				throw new Error("Unsupported quoted value in target env file; use a separate file.");
			}
		} else offset = lineEnd;
		const text = content.slice(start, offset);
		if (!Object.hasOwn(parseEnv(text), name)) throw new Error("Invalid target env assignment.");
		result.push({ name, text });
	}
	return result;
}

function encode(name: string, value: string): string {
	if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name) || value.includes("\0")) {
		throw new Error("Vault contains an invalid environment field.");
	}
	// Literal quoting avoids expanding $, #, backslashes, or multiline secrets.
	for (const quote of ["'", '"', "`"]) {
		if (value.includes(quote)) continue;
		const text = `${name}=${quote}${value}${quote}\n`;
		if (parseEnv(text)[name] === value) return text;
	}
	const unquoted = `${name}=${value}\n`;
	if (/^[^\s#'"`]+$/.test(value) && parseEnv(unquoted)[name] === value) return unquoted;
	throw new Error(`Cannot safely encode ${name} as dotenv text; use an authorized Vault read.`);
}

const digest = (salt: string, text: string) =>
	createHash("sha256").update(salt).update(text).digest("hex");

export function readVaultBinding(content: string): VaultEnvBinding | undefined {
	const markers = records(content).filter((row) => row.text.startsWith(MARKER));
	if (markers.length > 1) throw new Error("Multiple Vault bindings in target file.");
	if (!markers[0]) return undefined;
	try {
		return bindingSchema.parse(JSON.parse(markers[0].text.slice(MARKER.length)));
	} catch {
		throw new Error("Invalid Vault binding; restore its metadata or choose a new target file.");
	}
}

export function renderVaultEnv(
	content: string,
	apiUrl: string,
	material: VaultMaterial,
	agentId?: string,
): string {
	const old = readVaultBinding(content);
	if (
		old &&
		(old.apiUrl !== apiUrl ||
			(old.agentId !== undefined && old.agentId !== agentId) ||
			old.userId !== material.user_id ||
			old.projectId !== material.project_id ||
			old.vaultId !== material.vault_id ||
			old.section !== material.section)
	)
		throw new Error(
			"Vault binding context changed; restore the original account/API/source or choose a new file.",
		);
	const parsed = records(content);
	const oldFields = new Map(Object.entries(old?.fields ?? {}));
	const itemIds = new Map(Object.entries(material.item_ids));
	const references = new Map(Object.entries(material.references));
	const byName = new Map<string, EnvRecord>();
	for (const row of parsed) {
		if (!row.name) continue;
		if (byName.has(row.name)) throw new Error(`Duplicate local variable: ${row.name}`);
		byName.set(row.name, row);
	}
	for (const [name, field] of oldFields) {
		const row = byName.get(name);
		if (!row || digest(old?.salt ?? "", row.text) !== field.hash) {
			throw new Error(
				`Local conflict: ${name}. Restore the managed assignment or choose a new file; nothing was written.`,
			);
		}
		if (itemIds.has(name) && itemIds.get(name) !== field.itemId) {
			throw new Error(
				`Vault field was replaced: ${name}. Choose a new file to bind the new source.`,
			);
		}
	}
	const binding: VaultEnvBinding = {
		version: 1,
		apiUrl,
		userId: material.user_id,
		...(agentId ? { agentId } : {}),
		projectId: material.project_id,
		vaultId: material.vault_id,
		section: material.section,
		salt: old?.salt ?? randomBytes(16).toString("hex"),
		fields: {},
	};
	const additions = new Map<string, string>();
	const fields = new Map<string, VaultEnvBinding["fields"][string]>();
	for (const [name, value] of Object.entries(material.values)) {
		if (byName.has(name) && !oldFields.has(name))
			throw new Error(`Unmanaged local variable conflicts with Vault: ${name}`);
		const itemId = itemIds.get(name);
		const reference = references.get(name);
		if (!itemId || !reference) throw new Error("Incomplete Vault source identity.");
		const text = encode(name, value);
		additions.set(name, text);
		fields.set(name, { itemId, reference, hash: digest(binding.salt, text) });
	}
	binding.fields = Object.fromEntries(fields);
	let output = "";
	for (const row of parsed) {
		if (row.text.startsWith(MARKER)) continue;
		if (row.name && oldFields.has(row.name)) {
			output += additions.get(row.name) ?? "";
			additions.delete(row.name);
		} else output += row.text;
	}
	if (output && !output.endsWith("\n")) output += "\n";
	return `${output}${[...additions.values()].join("")}${MARKER}${JSON.stringify(binding)}\n`;
}

function requireUntrackedIgnored(path: string): void {
	const cwd = dirname(path);
	const repo = spawnSync("git", ["rev-parse", "--show-toplevel"], { cwd, encoding: "utf8" });
	if (repo.status !== 0) {
		if (repo.status === 128 && repo.stderr.includes("not a git repository")) return;
		throw new Error("Could not verify Git safety for target file.");
	}
	const tracked = spawnSync("git", ["ls-files", "--error-unmatch", "--", basename(path)], {
		cwd,
		encoding: "utf8",
	});
	const ignored = spawnSync("git", ["check-ignore", "-q", "--", basename(path)], {
		cwd,
		encoding: "utf8",
	});
	if (tracked.status !== 1 || ignored.status !== 0) {
		throw new Error(
			"Target must be untracked and Git-ignored. Add its path to .gitignore or choose a file outside the repository.",
		);
	}
}

function readTarget(path: string): string {
	if (!existsSync(path)) {
		// existsSync follows symlinks, including dangling ones.
		try {
			lstatSync(path);
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return "";
			throw error;
		}
		throw new Error("Target must be a regular file.");
	}
	const fd = openSync(path, constants.O_RDONLY | constants.O_NOFOLLOW);
	try {
		const stat = fstatSync(fd);
		if (!stat.isFile() || stat.nlink !== 1 || stat.size > 4 * 1024 * 1024)
			throw new Error("Target must be a regular, unlinked env file under 4 MiB.");
		return readFileSync(fd, "utf8");
	} finally {
		closeSync(fd);
	}
}

/** One file is the atomic unit: secret assignments and binding advance together. */
export async function updateVaultEnv(
	target: string,
	load: (
		binding: VaultEnvBinding | undefined,
	) => Promise<{ apiUrl: string; material: VaultMaterial }>,
	context?: { root: string; agentId: string },
): Promise<{ path: string; fields: number; added: number; updated: number; deleted: number }> {
	if (process.platform === "win32")
		throw new Error("Vault env materialization requires POSIX permissions; use WSL on Windows.");
	if (!isAbsolute(target)) throw new Error("Supply an explicit absolute --out path.");
	const outputPath = resolve(target);
	const parentPath = dirname(outputPath);
	if (
		context &&
		(parentPath !== context.root ||
			!/^(?:\.env(?:\.[A-Za-z0-9_-]+)*|[A-Za-z0-9_-]+\.env)$/.test(basename(outputPath)))
	) {
		throw new Error("Target must be an env filename directly inside the authenticated workspace.");
	}
	const parent = parentPath;
	if (realpathSync(parent) !== parent || (lstatSync(parent).mode & 0o022) !== 0) {
		throw new Error("Target directory must be real and not writable by other users.");
	}
	// Pin the directory for all I/O. A replaced ancestor cannot redirect a write.
	// Linux procfs also lets Git inspect the same directory without resolving tenant paths again.
	if (context && process.platform !== "linux")
		throw new Error("Workspace-scoped Vault files require Linux.");
	const directoryFd = context
		? openSync(parent, constants.O_RDONLY | constants.O_DIRECTORY | constants.O_NOFOLLOW)
		: undefined;
	const anchoredParent =
		directoryFd === undefined ? parent : `/proc/${process.pid}/fd/${directoryFd}`;
	try {
		const path = join(anchoredParent, basename(outputPath));
		requireUntrackedIgnored(path);
		const lock = `${path}.clawdi-lock`;
		let lockFd: number;
		try {
			lockFd = openSync(lock, "wx", 0o600);
		} catch {
			throw new Error(
				"Target is locked; wait for the other pull or remove a stale .clawdi-lock after verifying it stopped.",
			);
		}
		let staging: string | undefined;
		try {
			const before = readTarget(path);
			const { apiUrl, material } = await load(readVaultBinding(before));
			const output = renderVaultEnv(before, apiUrl, material, context?.agentId);
			if (Buffer.byteLength(output) > 4 * 1024 * 1024)
				throw new Error("Materialized env file exceeds 4 MiB; select a smaller section.");
			staging = mkdtempSync(join(anchoredParent, ".clawdi-vault-"));
			writeFileSync(join(staging, ".gitignore"), "*\n", { mode: 0o600 });
			const temporary = join(staging, "env");
			requireUntrackedIgnored(temporary);
			const fd = openSync(temporary, "wx", 0o600);
			try {
				writeFileSync(fd, output);
				fsyncSync(fd);
			} finally {
				closeSync(fd);
			}
			requireUntrackedIgnored(path);
			if (readTarget(path) !== before)
				throw new Error("Target changed during pull; nothing was written.");
			if (context && realpathSync(anchoredParent) !== context.root)
				throw new Error("Workspace moved during pull; nothing was written.");
			renameSync(temporary, path);
			const directory = openSync(anchoredParent, constants.O_RDONLY);
			try {
				fsyncSync(directory);
			} finally {
				closeSync(directory);
			}
			const previous = readVaultBinding(before)?.fields ?? {};
			const current = readVaultBinding(output)?.fields ?? {};
			return {
				path: outputPath,
				fields: Object.keys(current).length,
				added: Object.keys(current).filter((key) => !Object.hasOwn(previous, key)).length,
				updated: Object.keys(current).filter(
					(key) => Object.hasOwn(previous, key) && previous[key]?.hash !== current[key]?.hash,
				).length,
				deleted: Object.keys(previous).filter((key) => !Object.hasOwn(current, key)).length,
			};
		} finally {
			if (staging) rmSync(staging, { recursive: true });
			closeSync(lockFd);
			unlinkSync(lock);
		}
	} finally {
		if (directoryFd !== undefined) closeSync(directoryFd);
	}
}
