import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import {
	chmodSync,
	existsSync,
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

export interface HostedHermesSkillExactSourceDriver {
	install(input: {
		home: string;
		appRoot: string;
		skill: PreparedHostedCatalogSkill;
		previouslyReserved: boolean;
	}): "installed" | "unchanged";
	verifyOwned(input: { home: string; appRoot: string; skill: PreparedHostedCatalogSkill }): boolean;
	uninstall(input: {
		home: string;
		appRoot: string;
		skillId: string;
		digest: string;
	}): "absent" | "removed";
}

function commandPath(home: string, appRoot: string): string {
	for (const candidate of [
		join(appRoot, "venv", "bin", "hermes"),
		join(home, ".local", "bin", "hermes"),
	]) {
		if (executableExists(candidate)) return candidate;
	}
	throw new Error("installed Hermes Skill CLI is unavailable");
}

function targetDir(home: string, skillId: string): string {
	return join(home, ".hermes", "skills", skillId);
}
function receiptPath(home: string, skillId: string): string {
	return join(home, ".hermes", "skills", ".clawdi-manifest-receipts", `${skillId}.json`);
}

function writeReceipt(home: string, skill: PreparedHostedCatalogSkill, target: string): void {
	writePrivateFileAtomic(
		receiptPath(home, skill.skillId),
		`${JSON.stringify({ schemaVersion: "clawdi.hermesManifestSkillReceipt.v1", skillId: skill.skillId, archiveSha256: skill.digest, fingerprint: fingerprint(boundedFiles(target)) })}\n`,
		{ mode: 0o600, dirMode: 0o700 },
	);
}

function receiptMatches(home: string, skillId: string, digest: string, target: string): boolean {
	let receipt: unknown;
	try {
		receipt = JSON.parse(readFileSync(receiptPath(home, skillId), "utf8"));
	} catch {
		return false;
	}
	const value =
		receipt && typeof receipt === "object" && !Array.isArray(receipt)
			? (receipt as Record<string, unknown>)
			: null;
	return (
		value?.schemaVersion === "clawdi.hermesManifestSkillReceipt.v1" &&
		value.skillId === skillId &&
		value.archiveSha256 === digest &&
		value.fingerprint === fingerprint(boundedFiles(target))
	);
}

function boundedFiles(root: string): Map<string, Buffer> | null {
	if (!existsSync(root) || lstatSync(root).isSymbolicLink() || !lstatSync(root).isDirectory())
		return null;
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
				if (bytes.byteLength > 16 * 1024 * 1024 || total > 32 * 1024 * 1024)
					throw new Error("oversized Skill tree");
				files.set(relative, bytes);
			} else throw new Error("unsupported Skill entry");
		}
	};
	try {
		visit(root);
		return files;
	} catch {
		return null;
	}
}

function sameFiles(left: Map<string, Buffer> | null, right: Map<string, Buffer> | null): boolean {
	if (!left || !right || left.size !== right.size) return false;
	for (const [name, bytes] of left) if (!right.get(name)?.equals(bytes)) return false;
	return true;
}

function fingerprint(files: Map<string, Buffer> | null): string | null {
	if (!files) return null;
	const hash = createHash("sha256");
	for (const [name, bytes] of [...files].sort(([left], [right]) => left.localeCompare(right)))
		hash.update(name).update("\0").update(bytes).update("\0");
	return hash.digest("hex");
}

function withStagedSkill<T>(
	skill: PreparedHostedCatalogSkill,
	operation: (sourceDir: string) => T,
): T {
	const root = mkdtempSync(join(tmpdir(), "clawdi-hermes-skill-"));
	try {
		const result = spawnSync("tar", ["-xzf", "-", "-C", root], {
			input: skill.tarBytes,
			stdio: ["pipe", "pipe", "pipe"],
			maxBuffer: 1024 * 1024,
		});
		if (result.status !== 0) throw new Error("prepared Skill archive could not be staged");
		const sourceDir = join(root, skill.skillId);
		if (!existsSync(join(sourceDir, "SKILL.md")))
			throw new Error("prepared Skill archive is invalid");
		chmodSync(root, 0o755);
		return operation(sourceDir);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
}

function rawSkillUrl(skill: PreparedHostedCatalogSkill): string {
	const repository = new URL(skill.source.url);
	const [owner, repo] = repository.pathname.slice(1).split("/");
	if (!owner || !repo)
		throw new Error("Hermes exact-source URL requires a canonical GitHub repository");
	return `https://raw.githubusercontent.com/${encodeURIComponent(owner)}/${encodeURIComponent(repo)}/${skill.source.commit}/${skill.source.path}/SKILL.md`;
}

function runHermes(input: { home: string; appRoot: string }, args: string[]) {
	return spawnRuntimeUserCommand(
		commandPath(input.home, input.appRoot),
		args,
		input.home,
		input.appRoot,
		{
			hermesHome: join(input.home, ".hermes"),
			timeoutMs: 120_000,
			maxBufferBytes: 1024 * 1024,
		},
	);
}

export const hostedHermesSkillExactSourceDriver: HostedHermesSkillExactSourceDriver = {
	install(input) {
		return withStagedSkill(input.skill, (sourceDir) => {
			const target = targetDir(input.home, input.skill.skillId);
			if (existsSync(target) && !input.previouslyReserved)
				throw new Error("Hermes Skill target is not paired with a manifest reservation");
			if (sameFiles(boundedFiles(sourceDir), boundedFiles(target))) {
				if (receiptMatches(input.home, input.skill.skillId, input.skill.digest, target))
					return "unchanged";
				throw new Error(
					"refusing to adopt a Hermes Skill without a matching Clawdi ownership receipt",
				);
			}
			if (!existsSync(target))
				rmSync(receiptPath(input.home, input.skill.skillId), { force: true });
			const args = [
				"skills",
				"install",
				rawSkillUrl(input.skill),
				"--name",
				input.skill.skillId,
				"--yes",
			];
			if (input.previouslyReserved) args.push("--force");
			const result = runHermes(input, args);
			if (result.status !== 0)
				throw new Error(
					`Hermes official Skill install failed: ${String(result.stderr || result.stdout).trim() || "unknown error"}`,
				);
			if (!sameFiles(boundedFiles(sourceDir), boundedFiles(target))) {
				rmSync(receiptPath(input.home, input.skill.skillId), { force: true });
				const rollback = runHermes(input, ["skills", "uninstall", input.skill.skillId, "--yes"]);
				if (rollback.status !== 0) {
					throw new Error(
						`Hermes URL install cannot losslessly express the exact catalog archive; rollback failed: ${String(rollback.stderr || rollback.stdout).trim() || "unknown error"}`,
					);
				}
				throw new Error(
					"Hermes URL install cannot losslessly express the exact catalog archive; official uninstall rollback completed",
				);
			}
			writeReceipt(input.home, input.skill, target);
			return "installed";
		});
	},
	verifyOwned(input) {
		return withStagedSkill(input.skill, (sourceDir) => {
			const target = targetDir(input.home, input.skill.skillId);
			return (
				sameFiles(boundedFiles(sourceDir), boundedFiles(target)) &&
				receiptMatches(input.home, input.skill.skillId, input.skill.digest, target)
			);
		});
	},
	uninstall(input) {
		const target = targetDir(input.home, input.skillId);
		if (!existsSync(target)) {
			rmSync(receiptPath(input.home, input.skillId), { force: true });
			return "absent";
		}
		if (!receiptMatches(input.home, input.skillId, input.digest, target))
			throw new Error("Hermes Skill bytes no longer match the manifest ownership receipt");
		const result = runHermes(input, ["skills", "uninstall", input.skillId, "--yes"]);
		if (result.status !== 0)
			throw new Error(
				`Hermes official Skill uninstall failed: ${String(result.stderr || result.stdout).trim() || "unknown error"}`,
			);
		rmSync(receiptPath(input.home, input.skillId), { force: true });
		return "removed";
	},
};
