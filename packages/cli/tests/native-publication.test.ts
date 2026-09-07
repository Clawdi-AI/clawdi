import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import * as tar from "tar";
import { validateNativePublicationArchive } from "../scripts/native-publication.mjs";
import { validateNativeArchive } from "../src/lib/native-activation";

const roots: string[] = [];
afterEach(() => {
	for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});

function payload(): string {
	const root = mkdtempSync(join(tmpdir(), "clawdi-native-publication-"));
	roots.push(root);
	for (const path of [
		"clawdi",
		"egress-addon/clawdi_egress_addon.py",
		"skills/clawdi/SKILL.md",
		"skills/hosted-versions/1/clawdi/SKILL.md",
		"skills/future-skill/SKILL.md",
	]) {
		mkdirSync(dirname(join(root, path)), { recursive: true });
		writeFileSync(join(root, path), "fixture\n");
	}
	return root;
}

async function archive(root: string): Promise<Buffer> {
	const file = join(root, "artifact.tar.gz");
	await tar.create({ file, cwd: root, gzip: true }, ["clawdi", "egress-addon", "skills"]);
	return readFileSync(file);
}

describe("native publication inventory", () => {
	test("accepts required resources and additional intentional skill files", async () => {
		expect(await validateNativePublicationArchive(await archive(payload()))).toBeUndefined();
	});

	test("rejects Python caches without changing legacy installation compatibility", async () => {
		for (const path of [
			"egress-addon/__pycache__/cache.json",
			"egress-addon/addon.pyc",
			"skills/future-skill/cache.pyo",
		]) {
			const root = payload();
			mkdirSync(dirname(join(root, path)), { recursive: true });
			writeFileSync(join(root, path), "cache\n");
			const bytes = await archive(root);
			expect(await validateNativeArchive(bytes)).toBeUndefined();
			await expect(validateNativePublicationArchive(bytes)).rejects.toThrow(
				"Python cache or bytecode",
			);
		}
	});

	test("retains the required addon source check", async () => {
		const root = payload();
		rmSync(join(root, "egress-addon", "clawdi_egress_addon.py"));
		await expect(validateNativePublicationArchive(await archive(root))).rejects.toThrow(
			"native archive is missing egress-addon/clawdi_egress_addon.py",
		);
	});
});
