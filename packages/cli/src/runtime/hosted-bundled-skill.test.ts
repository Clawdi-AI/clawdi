import { afterEach, describe, expect, test } from "bun:test";
import {
	cpSync,
	existsSync,
	mkdtempSync,
	readFileSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import {
	assertHostedBundledSkillCatalogDigest,
	resolveHostedBundledSkill,
} from "./hosted-bundled-skill";
import { prepareHostedBundledSkill } from "./hosted-sourced-skill-archive";
import { withPreparedHostedSkill } from "./managed-skill-delivery";

const catalogEntry = resolveHostedBundledSkill("clawdi", 1);
const bundledSourceDir = resolve(import.meta.dir, "../../skills/hosted-versions/1/clawdi");
let root = "";

afterEach(() => {
	if (root) rmSync(root, { recursive: true, force: true });
	root = "";
});

describe("hosted bundled Skill preparation", () => {
	test("captures the immutable catalog tree as a prepared bundled source", () => {
		const prepared = prepareHostedBundledSkill("clawdi", 1);
		expect(prepared.identity).toEqual({
			source: {
				type: "bundled",
				version: 1,
				digest: catalogEntry.digest,
				assetDirectory: catalogEntry.assetDirectory,
			},
			version: 1,
			digest: catalogEntry.digest,
		});
		expect("sourceDir" in prepared && prepared.sourceDir).toBe(bundledSourceDir);

		expect(
			withPreparedHostedSkill(prepared, (sourceDir) => {
				expect(readFileSync(join(sourceDir, "SKILL.md"))).toEqual(
					readFileSync(join(bundledSourceDir, "SKILL.md")),
				);
				expect(existsSync(join(sourceDir, ".clawdi-managed.json"))).toBe(false);
				return "prepared" as const;
			}),
		).toBe("prepared");
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

		const legacy = join(root, "legacy-marker");
		cpSync(bundledSourceDir, legacy, { recursive: true });
		writeFileSync(
			join(legacy, ".clawdi-managed.json"),
			`${JSON.stringify({ managedBy: "clawdi runtime init", skillName: "clawdi" })}\n`,
		);
		expect(() => assertHostedBundledSkillCatalogDigest(catalogEntry, legacy)).toThrow(
			"catalog digest mismatch",
		);

		cpSync(bundledSourceDir, copied, { recursive: true, force: true });
		const outside = join(root, "outside");
		writeFileSync(outside, "outside\n");
		symlinkSync(outside, join(copied, "linked"));
		expect(() => assertHostedBundledSkillCatalogDigest(catalogEntry, copied)).toThrow(
			"non-regular entry",
		);
	});
});
