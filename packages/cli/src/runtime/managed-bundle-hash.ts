import { createHash } from "node:crypto";

export interface ManagedBundleHashEntry {
	relativePath: string;
	mode: number;
	content: Uint8Array;
}

function updateLengthPrefixed(hash: ReturnType<typeof createHash>, value: Uint8Array): void {
	const length = Buffer.allocUnsafe(8);
	length.writeBigUInt64BE(BigInt(value.byteLength));
	hash.update(length);
	hash.update(value);
}

function updatePermissionBits(hash: ReturnType<typeof createHash>, mode: number): void {
	if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777) {
		throw new Error(`invalid regular-file permission bits: ${mode}`);
	}
	const encoded = Buffer.allocUnsafe(2);
	encoded.writeUInt16BE(mode);
	hash.update(encoded);
}

export function canonicalManagedBundleFileMode(mode: number): 0o644 | 0o755 {
	if (!Number.isSafeInteger(mode) || mode < 0 || mode > 0o777) {
		throw new Error(`invalid regular-file permission bits: ${mode}`);
	}
	return (mode & 0o111) !== 0 ? 0o755 : 0o644;
}

/** Hash a deterministic regular-file tree with unambiguous path/mode/content framing. */
export function computeManagedBundleHash(entries: readonly ManagedBundleHashEntry[]): string {
	const sorted = [...entries].sort((left, right) =>
		left.relativePath < right.relativePath ? -1 : left.relativePath > right.relativePath ? 1 : 0,
	);
	const hash = createHash("sha256");
	hash.update("clawdi.managed-bundle.v2\0");
	let previousPath: string | null = null;
	for (const entry of sorted) {
		if (!entry.relativePath || entry.relativePath === previousPath) {
			throw new Error(`invalid or duplicate file-tree path: ${entry.relativePath}`);
		}
		previousPath = entry.relativePath;
		updateLengthPrefixed(hash, Buffer.from(entry.relativePath, "utf-8"));
		updatePermissionBits(hash, canonicalManagedBundleFileMode(entry.mode));
		updateLengthPrefixed(hash, entry.content);
	}
	return hash.digest("hex");
}
