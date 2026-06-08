import {
	type KeyImportSummary,
	type ParsedKey,
	parseVaultKeyImport,
} from "@/components/vault/key-import-parse";

export interface KeyImportPreviewRow extends ParsedKey {
	exists: boolean;
	action: "create" | "update" | "skip";
}

export function buildKeyImportPreview(
	text: string,
	existingKeys: ReadonlySet<string>,
	updateExisting: boolean,
) {
	const parsed = parseVaultKeyImport(text);
	const preview: KeyImportPreviewRow[] = parsed.entries.map((entry) => {
		const exists = existingKeys.has(entry.key);
		return {
			...entry,
			exists,
			action: exists ? (updateExisting ? "update" : "skip") : "create",
		};
	});
	const importableRows = preview.filter((entry) => entry.action !== "skip");
	const summary: KeyImportSummary = {
		created: importableRows.filter((entry) => entry.action === "create").length,
		updated: importableRows.filter((entry) => entry.action === "update").length,
		skipped: preview.filter((entry) => entry.action === "skip").length,
	};
	const fields = Object.fromEntries(importableRows.map((entry) => [entry.key, entry.value]));
	return {
		parsed,
		preview,
		conflicts: preview.filter((entry) => entry.exists),
		importableRows,
		fields,
		summary,
	};
}
