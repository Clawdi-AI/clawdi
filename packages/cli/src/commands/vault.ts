import { readFileSync } from "node:fs";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { ApiClient } from "../lib/api-client";
import { isLoggedIn } from "../lib/config";
import { sanitizeMetadata } from "../lib/sanitize";

function requireAuth() {
	if (!isLoggedIn()) {
		console.log(chalk.red("Not logged in. Run `clawdi auth login` first."));
		process.exit(1);
	}
}

export async function vaultSet(key: string) {
	requireAuth();

	const { vaultSlug, section, field } = parseVaultKey(key);

	const value = await p.password({ message: `Value for ${key}:` });
	if (p.isCancel(value) || !value) {
		p.cancel("Cancelled.");
		return;
	}

	const api = new ApiClient();

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

export async function vaultList(opts: { json?: boolean } = {}) {
	requireAuth();
	const api = new ApiClient();
	const { items: vaults } = await api.get<{
		items: Array<{ slug: string; name: string }>;
	}>("/api/vault?page_size=100");

	if (opts.json || !process.stdout.isTTY) {
		const out: Record<string, Record<string, string[]>> = {};
		for (const v of vaults) {
			out[v.slug] = await api.get<Record<string, string[]>>(`/api/vault/${v.slug}/items`);
		}
		console.log(JSON.stringify(out, null, 2));
		return;
	}

	if (vaults.length === 0) {
		console.log(chalk.gray("No vaults."));
		return;
	}

	for (const v of vaults) {
		const items = await api.get<Record<string, string[]>>(`/api/vault/${v.slug}/items`);
		console.log(chalk.white(`  ${sanitizeMetadata(v.slug)}`));
		for (const [section, fields] of Object.entries(items)) {
			for (const field of fields) {
				const display =
					section === "(default)"
						? sanitizeMetadata(field)
						: `${sanitizeMetadata(section)}/${sanitizeMetadata(field)}`;
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
	const cleaned = key.replace(/^clawdi:\/\//, "");
	const [a = "", b = "", c = ""] = cleaned.split("/");
	if (c) return { vaultSlug: a, section: b, field: c };
	if (b) return { vaultSlug: a, section: "", field: b };
	return { vaultSlug: "default", section: "", field: a };
}
