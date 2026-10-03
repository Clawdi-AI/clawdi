import type { VaultClient, VaultIdentity } from "./vault-client";
import { slugFromVaultName } from "./vault-state";
import { transferVaultKeys, type VaultKeySelection } from "./vault-transfer";

export type VaultPrefixGroup = { prefix: string; slug: string; keys: VaultKeySelection[] };

/** Keep exact prefixes separate even when their proposed slugs collide. */
export function prefixGroupsFor(keys: readonly VaultKeySelection[]): VaultPrefixGroup[] {
	const groups = new Map<string, VaultPrefixGroup>();
	const seen = new Set<string>();
	for (const key of keys) {
		const match = /^([A-Za-z0-9_.-]+)\/(.+)$/.exec(key.name);
		if (!match?.[1]) continue;
		const prefix = `${match[1]}/`;
		const slug = slugFromVaultName(match[1]);
		const section = key.section === "(default)" ? "" : key.section;
		const identity = JSON.stringify([section, key.name]);
		if (!slug || seen.has(identity)) continue;
		seen.add(identity);
		const group: VaultPrefixGroup = groups.get(prefix) ?? { prefix, slug, keys: [] };
		group.keys.push({ section, name: key.name });
		groups.set(prefix, group);
	}
	return [...groups.values()]
		.filter((group) => group.keys.length >= 2)
		.sort((a, b) => b.keys.length - a.keys.length || a.prefix.localeCompare(b.prefix));
}

/** Validate the entire selected plan before creating any destination. */
export function validVaultSplit(
	source: VaultIdentity,
	groups: readonly VaultPrefixGroup[],
): boolean {
	const slugs = new Set<string>();
	const prefixes = new Set<string>();
	if (!groups.length || !source.id.trim() || source.id !== source.id.trim()) return false;
	return groups.every((group) => {
		if (
			!/^[a-z0-9](?:[a-z0-9-]{0,198}[a-z0-9])?$/.test(group.slug) ||
			group.slug === source.slug ||
			slugs.has(group.slug) ||
			prefixes.has(group.prefix) ||
			!/^[A-Za-z0-9_.-]+\/$/.test(group.prefix) ||
			group.prefix.length > 200 ||
			!group.keys.length
		)
			return false;
		slugs.add(group.slug);
		prefixes.add(group.prefix);
		return group.keys.every((key) => {
			const section = key.section === "(default)" ? "" : key.section;
			return (
				/^[A-Za-z0-9_.-]{0,200}$/.test(section) &&
				key.name.startsWith(group.prefix) &&
				key.name === key.name.trim() &&
				[...key.name].length <= 200 &&
				key.name.length > group.prefix.length
			);
		});
	});
}

export type VaultSplitResult = {
	groups: {
		prefix: string;
		slug: string;
		target?: VaultIdentity;
		transfer?: Awaited<ReturnType<typeof transferVaultKeys>>;
		status: "complete" | "partial" | "unconfirmed";
	}[];
	interrupted: boolean;
};

/** Creation is strict, transfers are exact-ID and non-atomic; partial destinations remain inspectable. */
export async function splitVaultKeys(
	source: VaultIdentity,
	groups: readonly VaultPrefixGroup[],
	removeOriginals: boolean,
	api: Pick<VaultClient, "create" | "copyItems" | "deleteItems">,
	isCurrent: () => boolean = () => true,
): Promise<VaultSplitResult> {
	if (!validVaultSplit(source, groups)) throw new Error("Invalid Vault split plan");
	const result: VaultSplitResult = { groups: [], interrupted: false };
	for (const group of groups) {
		if (!isCurrent()) {
			result.interrupted = true;
			break;
		}
		const outcome: VaultSplitResult["groups"][number] = {
			prefix: group.prefix,
			slug: group.slug,
			status: "unconfirmed",
		};
		result.groups.push(outcome);
		try {
			const created = await api.create({ slug: group.slug, name: group.prefix.slice(0, -1) });
			if (!created.id || created.id === source.id || created.slug !== group.slug)
				throw new Error("Unconfirmed destination");
			const target = { id: created.id, slug: created.slug };
			outcome.target = target;
			if (!isCurrent()) {
				result.interrupted = true;
				break;
			}
			outcome.transfer = await transferVaultKeys(group.keys, removeOriginals ? "move" : "copy", {
				copy: (section, fields) =>
					api.copyItems(source, target, { section, fields, strip_prefix: group.prefix }),
				remove: (section, fields) => api.deleteItems(source, { section, fields }, true),
				isCurrent,
			});
			outcome.status =
				outcome.transfer.interrupted ||
				outcome.transfer.failed.length ||
				outcome.transfer.sourceRemoveFailed.length
					? "partial"
					: "complete";
		} catch {
			// Neither a failed create nor an unknown mutation is retried or replaced with slug fallback.
		}
	}
	result.interrupted ||= !isCurrent();
	return result;
}
