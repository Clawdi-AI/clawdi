import { readFileSync } from "node:fs";
import * as p from "@clack/prompts";
import chalk from "chalk";
import { ApiClient, unwrap } from "../lib/api-client";
import { isLoggedIn } from "../lib/config";
import { sanitizeMetadata } from "../lib/sanitize";

function requireAuth() {
	if (!isLoggedIn()) {
		console.log(chalk.red("Not logged in. Run `clawdi auth login` first."));
		process.exit(1);
	}
}

/**
 * Create a vault if it doesn't exist. 409 is the common "already exists"
 * response and is expected when the caller is about to PUT items into a
 * pre-existing vault; everything else propagates as a normal ApiError so
 * users see auth/network failures instead of a silent skip.
 */
async function ensureVault(api: ApiClient, slug: string, name = slug) {
	const created = await api.POST("/api/vault", { body: { slug, name } });
	if (created.error !== undefined && created.response.status !== 409) {
		unwrap(created);
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
	await ensureVault(api, vaultSlug);

	unwrap(
		await api.PUT("/api/vault/{slug}/items", {
			params: { path: { slug: vaultSlug } },
			body: { section, fields: { [field]: value } },
		}),
	);

	console.log(chalk.green(`✓ Stored ${key}`));
}

export async function vaultList(opts: { json?: boolean } = {}) {
	requireAuth();
	const api = new ApiClient();
	// `page_size=100` covers ~all realistic tenants; if someone crosses it we
	// surface the overflow below rather than silently dropping vaults.
	const VAULT_PAGE_SIZE = 100;
	const page = unwrap(
		await api.GET("/api/vault", { params: { query: { page_size: VAULT_PAGE_SIZE } } }),
	);
	const vaults = page.items;

	const fetchItems = (slug: string) =>
		api.GET("/api/vault/{slug}/items", { params: { path: { slug } } }).then(unwrap);

	if (opts.json || !process.stdout.isTTY) {
		const out: Record<string, Awaited<ReturnType<typeof fetchItems>>> = {};
		for (const v of vaults) out[v.slug] = await fetchItems(v.slug);
		console.log(JSON.stringify(out, null, 2));
		return;
	}

	if (vaults.length === 0) {
		console.log(chalk.gray("No vaults."));
		return;
	}

	if (page.total > vaults.length) {
		console.log(
			chalk.yellow(`  Showing ${vaults.length} of ${page.total} vaults (first page only).`),
		);
	}

	for (const v of vaults) {
		const items = await fetchItems(v.slug);
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

	await ensureVault(api, "default", "Default");

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

	unwrap(
		await api.PUT("/api/vault/{slug}/items", {
			params: { path: { slug: "default" } },
			body: { section: "", fields },
		}),
	);

	console.log(chalk.green(`✓ Imported ${Object.keys(fields).length} keys to vault "default"`));
}

function parseVaultKey(key: string): { vaultSlug: string; section: string; field: string } {
	const cleaned = key.replace(/^clawdi:\/\//, "");
	const [a = "", b = "", c = ""] = cleaned.split("/");
	if (c) return { vaultSlug: a, section: b, field: c };
	if (b) return { vaultSlug: a, section: "", field: b };
	return { vaultSlug: "default", section: "", field: a };
}
