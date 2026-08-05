import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	existsSync,
	chmodSync,
	lstatSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writePrivateFileAtomic } from "../lib/private-file";
import type { PreparedHostedCatalogSkill } from "./hosted-catalog-skill-archive";
import { executableExists, spawnRuntimeUserCommand } from "./runtime-user-command";

const OPENCLAW_AGENT_ID = "main";
const SOURCE_RECEIPT = join(".openclaw", "source-origin.json");

export interface HostedOpenClawSkillDriver {
	installDirectory(input: { home: string; workspaceRoot: string; skillId: string; sourceDir: string; digest: string }): "installed" | "unchanged";
	install(input: { home: string; workspaceRoot: string; skill: PreparedHostedCatalogSkill }): "installed" | "unchanged";
	verifyOwned(input: { workspaceRoot: string; skill: PreparedHostedCatalogSkill }): boolean;
	cleanupManifestOwned(input: { workspaceRoot: string; skillId: string }): "absent" | "removed";
}

function commandPath(home: string): string {
	for (const candidate of [join(home, ".local", "bin", "openclaw"), join(home, ".openclaw", "bin", "openclaw")]) {
		if (executableExists(candidate)) return candidate;
	}
	throw new Error("installed OpenClaw Skill CLI is unavailable");
}

function boundedFiles(root: string): Map<string, Buffer> | null {
	if (!existsSync(root) || lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory()) return null;
	const files = new Map<string, Buffer>();
	let entries = 0;
	let total = 0;
	const visit = (dir: string, prefix = "") => {
		for (const entry of readdirSync(dir, { withFileTypes: true })) {
			entries += 1;
			if (entries > 1024 || entry.isSymbolicLink()) throw new Error("unsafe Skill tree");
			const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
			const path = join(dir, entry.name);
			if (entry.isDirectory()) visit(path, relative);
			else if (entry.isFile()) {
				const bytes = readFileSync(path);
				total += bytes.byteLength;
				if (bytes.byteLength > 16 * 1024 * 1024 || total > 32 * 1024 * 1024) throw new Error("oversized Skill tree");
				if (relative !== SOURCE_RECEIPT) files.set(relative, bytes);
			} else throw new Error("unsupported Skill entry");
		}
	};
	try { visit(root); return files; } catch { return null; }
}

function sameFiles(left: Map<string, Buffer> | null, right: Map<string, Buffer> | null): boolean {
	if (!left || !right || left.size !== right.size) return false;
	for (const [name, bytes] of left) if (!right.get(name)?.equals(bytes)) return false;
	return true;
}

function fileFingerprint(files: Map<string, Buffer> | null): string | null {
	if (!files) return null;
	const hash = createHash("sha256");
	for (const [name, bytes] of [...files].sort(([left], [right]) => left.localeCompare(right))) {
		hash.update(name).update("\0").update(bytes).update("\0");
	}
	return hash.digest("hex");
}

function receiptPath(workspaceRoot: string, skillId: string): string {
	return join(workspaceRoot, "skills", ".clawdi-manifest-receipts", `${skillId}.json`);
}

function writeReceipt(input: { workspaceRoot: string; skillId: string; digest: string; target: string }): void {
	writePrivateFileAtomic(
		receiptPath(input.workspaceRoot, input.skillId),
		`${JSON.stringify({
			schemaVersion: "clawdi.openclawManifestSkillReceipt.v1",
			skillId: input.skillId,
			archiveSha256: input.digest,
			fingerprint: fileFingerprint(boundedFiles(input.target)),
		})}\n`,
		{ mode: 0o600, dirMode: 0o700 },
	);
}

function withStagedSkill<T>(skill: PreparedHostedCatalogSkill, callback: (sourceDir: string) => T): T {
	const root = mkdtempSync(join(tmpdir(), "clawdi-openclaw-skill-"));
	try {
		const extracted = spawnSync("tar", ["-xzf", "-", "-C", root], {
			input: skill.tarBytes,
			stdio: ["pipe", "pipe", "pipe"],
			maxBuffer: 1024 * 1024,
		});
		if (extracted.status !== 0) throw new Error("prepared Skill archive could not be staged");
		const sourceDir = join(root, skill.skillId);
		if (!existsSync(join(sourceDir, "SKILL.md"))) throw new Error("prepared Skill archive is invalid");
		const makeReadable = (path: string): void => {
			const node = lstatSync(path);
			if (node.isSymbolicLink()) throw new Error("prepared Skill archive contains a symlink");
			if (node.isDirectory()) {
				chmodSync(path, 0o755);
				for (const entry of readdirSync(path)) makeReadable(join(path, entry));
				return;
			}
			if (!node.isFile()) throw new Error("prepared Skill archive contains an unsupported entry");
			chmodSync(path, node.mode & 0o111 ? 0o755 : 0o644);
		};
		makeReadable(root);
		return callback(sourceDir);
	} finally { rmSync(root, { recursive: true, force: true }); }
}

function targetDir(workspaceRoot: string, skillId: string): string { return join(workspaceRoot, "skills", skillId); }

export const hostedOpenClawSkillDriver: HostedOpenClawSkillDriver = {
	installDirectory(input) {
		const target = targetDir(input.workspaceRoot, input.skillId);
		if (sameFiles(boundedFiles(input.sourceDir), boundedFiles(target))) {
			writeReceipt({ workspaceRoot: input.workspaceRoot, skillId: input.skillId, digest: input.digest, target });
			return "unchanged";
		}
		const result = spawnRuntimeUserCommand(
			commandPath(input.home),
			["skills", "install", input.sourceDir, "--agent", OPENCLAW_AGENT_ID, "--as", input.skillId, "--force"],
			input.home,
			input.workspaceRoot,
			{ timeoutMs: 120_000, maxBufferBytes: 1024 * 1024 },
		);
		if (result.status !== 0) throw new Error(`OpenClaw official Skill install failed: ${String(result.stderr || result.stdout).trim() || "unknown error"}`);
		if (!sameFiles(boundedFiles(input.sourceDir), boundedFiles(target))) {
			throw new Error(`OpenClaw installed Skill outside the configured agent workspace or changed exact source bytes: ${target}`);
		}
		writeReceipt({ workspaceRoot: input.workspaceRoot, skillId: input.skillId, digest: input.digest, target });
		return "installed";
	},
	install(input) {
		return withStagedSkill(input.skill, (sourceDir) => {
			return this.installDirectory({ home: input.home, workspaceRoot: input.workspaceRoot, skillId: input.skill.skillId, sourceDir, digest: input.skill.digest });
		});
	},
	verifyOwned(input) { return withStagedSkill(input.skill, (sourceDir) => sameFiles(boundedFiles(sourceDir), boundedFiles(targetDir(input.workspaceRoot, input.skill.skillId)))); },
	cleanupManifestOwned(input) {
		const target = targetDir(input.workspaceRoot, input.skillId);
		if (!existsSync(target)) return "absent";
		let receipt: unknown;
		try { receipt = JSON.parse(readFileSync(receiptPath(input.workspaceRoot, input.skillId), "utf8")); } catch { receipt = null; }
		const value = receipt && typeof receipt === "object" && !Array.isArray(receipt) ? receipt as Record<string, unknown> : null;
		if (value?.schemaVersion !== "clawdi.openclawManifestSkillReceipt.v1" || value.skillId !== input.skillId || value.fingerprint !== fileFingerprint(boundedFiles(target))) {
			throw new Error("refusing manifest cleanup because OpenClaw Skill bytes no longer match the ownership receipt");
		}
		// OpenClaw has no general native uninstall for local-directory installs.
		rmSync(target, { recursive: true });
		rmSync(receiptPath(input.workspaceRoot, input.skillId), { force: true });
		return "removed";
	},
};
