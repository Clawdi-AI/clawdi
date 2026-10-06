import { expect, test } from "bun:test";
import { buildKeyImportPreview } from "./vault-import-preview";
import { parseVaultKeyImport, parseVaultRequestEnv } from "./vault-key-import";
import { slugFromVaultName } from "./vault-state";

test("shared import preview skips conflicts unless explicitly selected for update", () => {
	const existing = new Set(["TOKEN"]);
	expect(buildKeyImportPreview("TOKEN=old\nNEW=new", existing, false).summary).toEqual({
		created: 1,
		updated: 0,
		skipped: 1,
	});
	expect(buildKeyImportPreview("TOKEN=old\nNEW=new", existing, false).fields).toEqual({
		NEW: "new",
	});
	expect(buildKeyImportPreview("TOKEN=old\nNEW=new", existing, true).fields).toEqual({
		TOKEN: "old",
		NEW: "new",
	});
});

test("invalid imports are atomic and values are never evaluated", () => {
	expect(parseVaultKeyImport("token=first\nTOKEN=second").entries).toEqual([]);
	expect(buildKeyImportPreview('OK=value\nBAD="unterminated', new Set(), true).fields).toEqual({});
	expect(
		parseVaultRequestEnv(`Mixed.Name=$(echo synthetic)\nOTHER=\${Mixed.Name}`).entries.map(
			({ key, value }) => [key, value],
		),
	).toEqual([
		["Mixed.Name", "$(echo synthetic)"],
		["OTHER", `\${Mixed.Name}`],
	]);
	expect(parseVaultRequestEnv('{"KEY":"synthetic"}').entries).toEqual([]);
});

test("Vault name normalization matches Web", () => {
	expect(slugFromVaultName(" My---Shared Vault! ")).toBe("my-shared-vault");
	expect(slugFromVaultName("密钥")).toBe("");
});
