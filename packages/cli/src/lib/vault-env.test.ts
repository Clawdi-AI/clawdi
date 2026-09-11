import { afterEach, describe, expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	mkdtempSync,
	readdirSync,
	readFileSync,
	rmSync,
	statSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { renderVaultEnv, updateVaultEnv, type VaultMaterial } from "./vault-env";

const apiUrl = "https://api.example.test";
const material: VaultMaterial = {
	user_id: "00000000-0000-4000-8000-000000000001",
	project_id: "00000000-0000-4000-8000-000000000002",
	vault_id: "00000000-0000-4000-8000-000000000003",
	section: null,
	item_ids: { TOKEN: "00000000-0000-4000-8000-000000000004" },
	references: { TOKEN: "clawdi://project/p/vault/v/field/TOKEN" },
	values: { TOKEN: "test-secret" },
};
const directories: string[] = [];
function temporary() {
	const dir = mkdtempSync(join(tmpdir(), "vault-env-"));
	directories.push(dir);
	return dir;
}
afterEach(() => {
	for (const path of directories.splice(0)) rmSync(path, { recursive: true, force: true });
});

describe("Vault file binding", () => {
	test("round trips literal secrets and preserves unrelated multiline assignments", () => {
		const untouched = "# user comment\nexport OTHER='line 1\nline 2' # keep\n";
		for (const value of [
			"a$#\\n\\path",
			"line1\nline2",
			"contains'quote",
			'contains"quote',
			"contains'and\"",
			"trailing\\",
			"",
		]) {
			const output = renderVaultEnv(untouched, apiUrl, { ...material, values: { TOKEN: value } });
			expect(output.startsWith(untouched)).toBe(true);
			expect(parseEnv(output).TOKEN).toBe(value);
		}
	});
	test("pull discovers additions and removes only unchanged previously managed values", () => {
		const initial = renderVaultEnv("OTHER=keep\nconstructor=preserved\n", apiUrl, material);
		const updated: VaultMaterial = {
			...material,
			item_ids: { ADDED: "00000000-0000-4000-8000-000000000005" },
			references: { ADDED: "clawdi://project/p/vault/v/field/ADDED" },
			values: { ADDED: "new" },
		};
		const next = renderVaultEnv(initial, apiUrl, updated);
		expect(parseEnv(next)).toEqual({ OTHER: "keep", constructor: "preserved", ADDED: "new" });
		expect(() =>
			renderVaultEnv(initial.replace("TOKEN='test-secret'", "TOKEN='local-edit'"), apiUrl, updated),
		).toThrow("Local conflict");
		expect(() =>
			renderVaultEnv(initial, apiUrl, { ...material, item_ids: updated.item_ids }),
		).toThrow();
	});
	test("blocks account/API/source switches, duplicate names and unmanaged collisions", () => {
		const initial = renderVaultEnv("", apiUrl, material);
		expect(() => renderVaultEnv(initial, "https://other.example.test", material)).toThrow(
			"context changed",
		);
		expect(() =>
			renderVaultEnv(initial, apiUrl, { ...material, user_id: material.project_id }),
		).toThrow("context changed");
		expect(() =>
			renderVaultEnv(initial, apiUrl, { ...material, vault_id: material.project_id }),
		).toThrow("context changed");
		expect(() =>
			renderVaultEnv(initial, apiUrl, { ...material, item_ids: { TOKEN: material.project_id } }),
		).toThrow("replaced");
		expect(() => renderVaultEnv("TOKEN=existing\n", apiUrl, material)).toThrow("Unmanaged");
		expect(() => renderVaultEnv("OTHER=1\nOTHER=2\n", apiUrl, material)).toThrow("Duplicate");
	});
	test("writes atomically at 0600, rejects tracked/unignored files, cleans temporary state", async () => {
		const dir = temporary();
		const out = join(dir, ".env");
		execFileSync("git", ["init", "-q", dir]);
		const load = async () => ({ apiUrl, material });
		await expect(updateVaultEnv(out, load)).rejects.toThrow("Git-ignored");
		writeFileSync(join(dir, ".gitignore"), ".env\n");
		const result = await updateVaultEnv(out, load);
		expect(result.fields).toBe(1);
		expect(JSON.stringify(result)).not.toContain("test-secret");
		expect(statSync(out).mode & 0o777).toBe(0o600);
		expect(readdirSync(dir).sort()).toEqual([".env", ".git", ".gitignore"]);
		const before = readFileSync(out, "utf8");
		await expect(
			updateVaultEnv(out, async () => {
				throw new Error("network failure");
			}),
		).rejects.toThrow("network failure");
		expect(readFileSync(out, "utf8")).toBe(before);
		execFileSync("git", ["add", "-f", "--", out], { cwd: dir });
		await expect(updateVaultEnv(out, load)).rejects.toThrow("Git-ignored");
	});
	test("rejects symlinks, competing pulls and edits made during network I/O", async () => {
		const dir = temporary();
		const out = join(dir, ".env");
		const real = join(dir, "real");
		writeFileSync(real, "OTHER=keep\n");
		symlinkSync(real, out);
		await expect(updateVaultEnv(out, async () => ({ apiUrl, material }))).rejects.toThrow();
		rmSync(out);
		writeFileSync(out, "OTHER=keep\n");
		await expect(
			updateVaultEnv(out, async () => {
				await expect(updateVaultEnv(out, async () => ({ apiUrl, material }))).rejects.toThrow(
					"locked",
				);
				writeFileSync(out, "OTHER=edited\n");
				return { apiUrl, material };
			}),
		).rejects.toThrow("changed during pull");
		expect(readFileSync(out, "utf8")).toBe("OTHER=edited\n");
		expect(readdirSync(dir).sort()).toEqual([".env", "real"]);
	});
});
