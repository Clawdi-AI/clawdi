import { readFileSync } from "node:fs";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { ApiClient } from "../lib/api-client";
import { isLoggedIn } from "../lib/config";

function requireAuth() {
	if (!isLoggedIn()) {
		console.log(chalk.red("Not logged in. Run `clawdi login` first."));
		process.exit(1);
	}
}

export async function vaultSet(key: string) {
	requireAuth();

	// Parse key: can be "VAULT/SECTION/FIELD" or just "FIELD" (default vault)
	const { vaultSlug, section, field } = parseVaultKey(key);

	const value = await p.password({ message: `Value for ${key}:` });
	if (p.isCancel(value) || !value) {
		p.cancel("Cancelled.");
		return;
	}

	const api = new ApiClient();

	// Ensure vault exists
	try {
		await api.post("/api/vault", { slug: vaultSlug, name: vaultSlug });
	} catch {
		// Already exists — fine
	}

	await api.request(`/api/vault/${vaultSlug}/items`, {
		method: "PUT",
		body: JSON.stringify({ section, fields: { [field]: value } }),
	});

	console.log(chalk.green(`✓ Stored ${key}`));
}

export async function vaultList() {
	requireAuth();
	const api = new ApiClient();
	const vaults = await api.get<Array<{ slug: string; name: string }>>("/api/vault");

	if (vaults.length === 0) {
		console.log(chalk.gray("No vaults."));
		return;
	}

	for (const v of vaults) {
		const items = await api.get<Record<string, string[]>>(`/api/vault/${v.slug}/items`);
		console.log(chalk.white(`  ${v.slug}`));
		for (const [section, fields] of Object.entries(items)) {
			for (const field of fields) {
				const display = section === "(default)" ? field : `${section}/${field}`;
				console.log(chalk.gray(`    ${display}`));
			}
		}
	}
}

export async function vaultImport(file: string) {
	requireAuth();

	const content = readFileSync(file, "utf-8");
	const lines = content.split("\n").filter((l) => l.trim() && !l.startsWith("#"));
	const api = new ApiClient();

	// Create default vault
	try {
		await api.post("/api/vault", { slug: "default", name: "Default" });
	} catch {
		// Already exists
	}

	const fields: Record<string, string> = {};
	for (const line of lines) {
		const eqIdx = line.indexOf("=");
		if (eqIdx === -1) continue;
		const key = line.slice(0, eqIdx).trim();
		let value = line.slice(eqIdx + 1).trim();
		// Remove surrounding quotes
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}
		fields[key] = value;
	}

	if (Object.keys(fields).length === 0) {
		console.log(chalk.gray("No keys found in file."));
		return;
	}

	p.note(Object.keys(fields).join("\n"), `${Object.keys(fields).length} keys from ${file}`);

	const ok = await p.confirm({ message: "Import these keys?" });
	if (p.isCancel(ok) || !ok) {
		p.cancel("Cancelled.");
		return;
	}

	await api.request("/api/vault/default/items", {
		method: "PUT",
		body: JSON.stringify({ section: "", fields }),
	});

	console.log(chalk.green(`✓ Imported ${Object.keys(fields).length} keys to vault "default"`));
}

function parseVaultKey(key: string): { vaultSlug: string; section: string; field: string } {
	// clawdi://vault/section/field or VAULT/SECTION/FIELD or just FIELD
	const cleaned = key.replace(/^clawdi:\/\//, "");
	const parts = cleaned.split("/");
	if (parts.length === 3) {
		return { vaultSlug: parts[0], section: parts[1], field: parts[2] };
	}
	if (parts.length === 2) {
		return { vaultSlug: parts[0], section: "", field: parts[1] };
	}
	return { vaultSlug: "default", section: "", field: parts[0] };
}
