import { expect, test } from "bun:test";
import { execFileSync } from "node:child_process";
import {
	mkdirSync,
	mkdtempSync,
	readdirSync,
	readFileSync,
	renameSync,
	rmSync,
	symlinkSync,
	writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { updateVaultEnv, type VaultMaterial } from "./vault-env";

const agentId = "00000000-0000-4000-8000-000000000001";
const material: VaultMaterial = {
	user_id: agentId,
	project_id: agentId,
	vault_id: agentId,
	section: null,
	values: { TOKEN: "private-value" },
	item_ids: { TOKEN: agentId },
	references: { TOKEN: "clawdi://project/p/vault/v/field/TOKEN" },
};
const load = async () => ({ apiUrl: "https://api.test", material });

test("pinned workspace rejects ancestor swaps during remote reads without writing outside", async () => {
	const base = mkdtempSync(join(tmpdir(), "vault-root-"));
	const root = join(base, "workspace");
	const outside = join(base, "outside");
	mkdirSync(root, { mode: 0o700 });
	mkdirSync(outside, { mode: 0o700 });
	try {
		await expect(
			updateVaultEnv(
				join(root, ".env"),
				async () => {
					renameSync(root, join(base, "original"));
					symlinkSync(outside, root);
					return load();
				},
				{ root, agentId },
			),
		).rejects.toThrow("Workspace moved");
		expect(readdirSync(outside)).toEqual([]);
		expect(readdirSync(join(base, "original"))).toEqual([]);
	} finally {
		rmSync(base, { recursive: true, force: true });
	}
});

test("workspace fd preserves Git checks and Agent binding across pulls", async () => {
	const root = mkdtempSync(join(tmpdir(), "vault-git-"));
	try {
		execFileSync("git", ["init", "-q", root]);
		const out = join(root, ".env");
		await expect(updateVaultEnv(out, load, { root, agentId })).rejects.toThrow("Git-ignored");
		writeFileSync(join(root, ".gitignore"), ".env\n");
		await updateVaultEnv(out, load, { root, agentId });
		const before = readFileSync(out, "utf8");
		await expect(
			updateVaultEnv(out, load, { root, agentId: "00000000-0000-4000-8000-000000000002" }),
		).rejects.toThrow("context changed");
		execFileSync("git", ["-C", root, "add", "-f", ".env"]);
		await expect(updateVaultEnv(out, load, { root, agentId })).rejects.toThrow("untracked");
		expect(readFileSync(out, "utf8")).toBe(before);
	} finally {
		rmSync(root, { recursive: true, force: true });
	}
});
