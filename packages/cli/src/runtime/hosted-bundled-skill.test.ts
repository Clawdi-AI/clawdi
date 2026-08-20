import { afterEach, describe, expect, test } from "bun:test";
import {
	chmodSync,
	cpSync,
	existsSync,
	mkdirSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import {
	adoptableLegacyHostedBundledSkill,
	assertHostedBundledSkillCatalogDigest,
	resolveHostedBundledSkill,
} from "./hosted-bundled-skill";
import { prepareHostedBundledSkillArchive } from "./hosted-sourced-skill-archive";
import { withStagedManagedSkill } from "./managed-skill-delivery";

const catalogEntry = resolveHostedBundledSkill("clawdi", 1);
const bundledSourceDir = resolve(import.meta.dir, "../../skills/hosted-versions/1/clawdi");
let root = "";

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

describe("hosted bundled Skill preparation", () => {
	test("captures the immutable catalog tree as a prepared bundled source", () => {
		const prepared = prepareHostedBundledSkillArchive("clawdi", 1);
		expect(prepared.source).toEqual({
			type: "bundled",
			version: 1,
			digest: catalogEntry.digest,
			assetDirectory: catalogEntry.assetDirectory,
		});
		expect(prepared.sourceIdentity).toBe(`content-sha256\0${catalogEntry.digest}`);
		expect(prepared.archiveSha256).toMatch(/^[a-f0-9]{64}$/);

		let stagingRoot = "";
		expect(
			withStagedManagedSkill(prepared, (sourceDir) => {
				stagingRoot = dirname(sourceDir);
				expect(readFileSync(join(sourceDir, "SKILL.md"))).toEqual(
					readFileSync(join(bundledSourceDir, "SKILL.md")),
				);
				expect(statSync(sourceDir).mode & 0o777).toBe(0o755);
				expect(statSync(join(sourceDir, "SKILL.md")).mode & 0o777).toBe(0o644);
				expect(existsSync(join(sourceDir, ".clawdi-managed.json"))).toBe(false);
				return "staged" as const;
			}),
		).toBe("staged");
		expect(existsSync(stagingRoot)).toBe(false);
	});

	test("fails closed for unknown catalog entries and source drift", () => {
		expect(() => resolveHostedBundledSkill("unknown", 1)).toThrow(
			"no bundled hosted skill is registered for unknown",
		);
		expect(() => resolveHostedBundledSkill("clawdi", 2)).toThrow(
			"no bundled hosted skill clawdi version 2 is registered",
		);

		root = mkdtempSync(join(tmpdir(), "hosted-bundled-source-"));
		const copied = join(root, "clawdi");
		cpSync(bundledSourceDir, copied, { recursive: true });
		writeFileSync(join(copied, "SKILL.md"), "catalog drift\n");
		expect(() => assertHostedBundledSkillCatalogDigest(catalogEntry, copied)).toThrow(
			"catalog digest mismatch",
		);

		cpSync(bundledSourceDir, copied, { recursive: true, force: true });
		const outside = join(root, "outside");
		writeFileSync(outside, "outside\n");
		symlinkSync(outside, join(copied, "linked"));
		expect(() => assertHostedBundledSkillCatalogDigest(catalogEntry, copied)).toThrow(
			"symbolic links are not supported",
		);
	});

	test("adopts legacy tree markers only while identity and bytes match exactly", () => {
		root = mkdtempSync(join(tmpdir(), "hosted-bundled-legacy-"));
		const target = join(root, "skills", "clawdi");
		mkdirSync(dirname(target), { recursive: true });
		cpSync(bundledSourceDir, target, { recursive: true });
		chmodSync(target, 0o755);
		chmodSync(join(target, "SKILL.md"), 0o644);
		const marker = join(target, ".clawdi-managed.json");
		writeFileSync(
			marker,
			`${JSON.stringify({ managedBy: "clawdi runtime init", skillName: "clawdi" })}\n`,
		);
		expect(adoptableLegacyHostedBundledSkill(target, "clawdi")).toEqual(catalogEntry);

		writeFileSync(
			marker,
			`${JSON.stringify({
				schema: "clawdi.hostedBundledSkillMarker.v1",
				owner: "clawdi runtime init",
				id: "clawdi",
				version: 1,
				digest: catalogEntry.digest,
			})}\n`,
		);
		expect(adoptableLegacyHostedBundledSkill(target, "clawdi")).toEqual(catalogEntry);
		writeFileSync(join(target, "SKILL.md"), "tenant bytes\n");
		expect(adoptableLegacyHostedBundledSkill(target, "clawdi")).toBeNull();
	});
});
