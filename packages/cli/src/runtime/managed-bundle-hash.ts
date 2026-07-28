import { createHash } from "node:crypto";

export interface ManagedBundleHashEntry {
	relativePath: string;
	content: Uint8Array;
}

function updateLengthPrefixed(hash: ReturnType<typeof createHash>, value: Uint8Array): void {
	const length = Buffer.allocUnsafe(8);
	length.writeBigUInt64BE(BigInt(value.byteLength));
	hash.update(length);
	hash.update(value);
}

/** Hash a deterministic file-only tree with unambiguous path/content framing. */
export function computeManagedBundleHash(entries: readonly ManagedBundleHashEntry[]): string {
	const sorted = [...entries].sort((left, right) =>
		left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
	);
	const hash = createHash("sha256");
	hash.update("clawdi.managed-bundle.v1\0");
	let previousPath: string | null = null;
	for (const entry of sorted) {
		if (!entry.relativePath || entry.relativePath === previousPath) {
			throw new Error(`invalid or duplicate file-tree path: ${entry.relativePath}`);
		}
		previousPath = entry.relativePath;
		updateLengthPrefixed(hash, Buffer.from(entry.relativePath, "utf-8"));
		updateLengthPrefixed(hash, entry.content);
	}
	return hash.digest("hex");
}
