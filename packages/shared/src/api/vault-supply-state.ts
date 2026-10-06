import { parseVaultRequestEnv, REQUEST_FIELD_NAME_RE } from "./vault-key-import";
import { safeVaultRequestUrl } from "./vault-request-state";

export type VaultSupplyRow = { name: string; value: string; required: boolean };
export function vaultRequestToken(value: string): string | null {
	const safe = safeVaultRequestUrl(value.trim());
	return safe ? new URL(safe).hash.slice(1) : null;
}
export function vaultSupplyFields(
	rows: readonly VaultSupplyRow[],
	required: readonly string[],
): Record<string, string> {
	const names = rows.map((row) => row.name);
	if (
		!rows.length ||
		rows.length > 32 ||
		new Set(names).size !== names.length ||
		names.some((name) => !REQUEST_FIELD_NAME_RE.test(name)) ||
		required.some((name) => !names.includes(name)) ||
		rows.some(({ value }) => !value || [...value].length > 65536 || value.includes("\0"))
	)
		throw new Error("Invalid credential fields");
	return Object.fromEntries(rows.map(({ name, value }) => [name, value]));
}
export function importVaultSupplyRows(
	rows: readonly VaultSupplyRow[],
	text: string,
): VaultSupplyRow[] {
	const parsed = parseVaultRequestEnv(text);
	if (parsed.errors.length || !parsed.entries.length) throw new Error("Invalid dotenv import");
	const incoming = new Map(parsed.entries.map((entry) => [entry.key, entry.value]));
	const result = rows.map((row) => ({ ...row, value: incoming.get(row.name) ?? row.value }));
	const existing = new Set(rows.map((row) => row.name));
	for (const entry of parsed.entries)
		if (!existing.has(entry.key))
			result.push({ name: entry.key, value: entry.value, required: false });
	if (result.length > 32 || new Set(result.map((row) => row.name)).size !== result.length)
		throw new Error("Invalid field selection");
	return result;
}
