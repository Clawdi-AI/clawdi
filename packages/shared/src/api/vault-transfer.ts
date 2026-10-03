import type { components } from "./api.generated";

export type VaultKeySelection = { section: string; name: string };
type CopyResult = components["schemas"]["VaultItemsCopyResponse"];
type DeleteResult = components["schemas"]["VaultItemsDeleteResponse"];

/** Values stay on the server. Copy/delete is not atomic and never automatically retried. */
export async function transferVaultKeys(
	keys: readonly VaultKeySelection[],
	mode: "copy" | "move",
	operations: {
		copy: (section: string, fields: string[]) => Promise<CopyResult>;
		remove: (section: string, fields: string[]) => Promise<DeleteResult>;
		isCurrent?: () => boolean;
	},
) {
	const groups = new Map<string, Set<string>>();
	for (const key of keys) {
		const section = key.section === "(default)" ? "" : key.section;
		// Existing legacy names can contain slashes; copy/delete use exact existing names.
		if (
			!/^[A-Za-z0-9_.-]{0,200}$/.test(section) ||
			!key.name ||
			key.name !== key.name.trim() ||
			[...key.name].length > 200
		)
			throw new Error("Invalid key selection");
		const group = groups.get(section) ?? new Set<string>();
		group.add(key.name);
		groups.set(section, group);
	}
	if (!groups.size) throw new Error("Select keys first");
	let copied = 0;
	const failed: string[] = [];
	const sourceRemoveFailed: string[] = [];
	let interrupted = false;
	const current = () => operations.isCurrent?.() ?? true;
	outer: for (const [section, names] of groups) {
		const keysInSection = [...names];
		for (let offset = 0; offset < keysInSection.length; offset += 150) {
			if (!current()) {
				interrupted = true;
				break outer;
			}
			const fields = keysInSection.slice(offset, offset + 150);
			const labels = fields.map((field) => `${section || "(default)"}/${field}`);
			let count: number;
			try {
				const result = await operations.copy(section, fields);
				if (
					result.status !== "ok" ||
					!Number.isInteger(result.copied) ||
					result.copied < 0 ||
					result.copied > fields.length
				)
					throw new Error("Unconfirmed copy");
				count = result.copied;
				copied += count;
			} catch {
				failed.push(...labels);
				continue;
			}
			if (count !== fields.length) {
				// The response has no per-key receipt. Never guess which source keys are safe to delete.
				failed.push(...labels);
				if (mode === "move") sourceRemoveFailed.push(...labels);
				continue;
			}
			if (mode === "move") {
				if (!current()) {
					sourceRemoveFailed.push(...labels);
					interrupted = true;
					break outer;
				}
				try {
					const result = await operations.remove(section, fields);
					if (result.status !== "deleted") throw new Error("Unconfirmed source deletion");
				} catch {
					sourceRemoveFailed.push(...labels);
				}
			}
		}
	}
	return { copied, failed, sourceRemoveFailed, interrupted: interrupted || !current() };
}
