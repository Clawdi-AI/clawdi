import { createHash } from "node:crypto";
import { lstatSync, readdirSync, readFileSync, rmSync } from "node:fs";
import { dirname, join } from "node:path";
import type { RuntimePaths } from "./paths";
import { writeRuntimePlatformFileAtomic } from "./state";

const CACHE_KEY = /^[a-f0-9]{64}$/;
const MAX_RECEIPT_BYTES = 4 * 1024;

interface ArchiveCacheReceiptReader {
	parse(value: unknown): { key: string; archiveSha256: string };
}

interface ArchiveCacheEntry {
	exists(): boolean;
	read(): Buffer | null;
	write(bytes: Buffer, receipt: (archiveSha256: string) => unknown): void;
	remove(options?: { allowIncomplete?: boolean }): boolean;
}

function sha256(bytes: Uint8Array): string {
	return createHash("sha256").update(bytes).digest("hex");
}

export function archiveCache(
	paths: RuntimePaths,
	root: string,
	key: string,
	archiveName: "skill.tar.gz" | "source.tar.gz",
	receiptReader: ArchiveCacheReceiptReader,
	maxArchiveBytes: number,
): ArchiveCacheEntry {
	if (!CACHE_KEY.test(key)) throw new Error("archive cache key is invalid");
	const entryRoot = join(root, key);
	if (dirname(entryRoot) !== root) throw new Error("archive cache key escapes its root");
	const archivePath = join(entryRoot, archiveName);
	const receiptPath = join(entryRoot, "receipt.json");
	const exists = (): boolean => {
		try {
			lstatSync(entryRoot);
			return true;
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
			throw error;
		}
	};
	const read = (): Buffer | null => {
		try {
			const archiveStat = lstatSync(archivePath);
			const receiptStat = lstatSync(receiptPath);
			if (
				!archiveStat.isFile() ||
				archiveStat.isSymbolicLink() ||
				archiveStat.size > maxArchiveBytes ||
				(archiveStat.mode & 0o777) !== 0o600 ||
				!receiptStat.isFile() ||
				receiptStat.isSymbolicLink() ||
				receiptStat.size > MAX_RECEIPT_BYTES ||
				(receiptStat.mode & 0o777) !== 0o600 ||
				(typeof process.getuid === "function" &&
					(archiveStat.uid !== process.getuid() || receiptStat.uid !== process.getuid()))
			) {
				return null;
			}
			const receipt = receiptReader.parse(JSON.parse(readFileSync(receiptPath, "utf8")) as unknown);
			const archive = readFileSync(archivePath);
			return receipt.key === key && sha256(archive) === receipt.archiveSha256 ? archive : null;
		} catch {
			return null;
		}
	};
	const remove = (options: { allowIncomplete?: boolean } = {}): boolean => {
		try {
			const rootStat = lstatSync(root);
			const entryStat = lstatSync(entryRoot);
			if (
				!rootStat.isDirectory() ||
				rootStat.isSymbolicLink() ||
				!entryStat.isDirectory() ||
				entryStat.isSymbolicLink() ||
				(options.allowIncomplete !== true && read() === null)
			) {
				return false;
			}
			for (const name of readdirSync(entryRoot)) {
				if (name !== archiveName && name !== "receipt.json") return false;
				const stat = lstatSync(join(entryRoot, name));
				if (!stat.isFile() || stat.isSymbolicLink()) return false;
			}
			rmSync(entryRoot, { recursive: true });
			return true;
		} catch (error) {
			if (error instanceof Error && "code" in error && error.code === "ENOENT") return false;
			throw error;
		}
	};
	return {
		exists,
		read,
		write: (bytes, createReceipt) => {
			if (bytes.length > maxArchiveBytes) throw new Error("archive exceeds its cache limit");
			const archiveSha256 = sha256(bytes);
			const receipt = createReceipt(archiveSha256);
			const parsed = receiptReader.parse(receipt);
			if (parsed.key !== key || parsed.archiveSha256 !== archiveSha256) {
				throw new Error("archive cache receipt does not match its entry");
			}
			try {
				writeRuntimePlatformFileAtomic(paths, archivePath, bytes, { mode: 0o600, dirMode: 0o700 });
				writeRuntimePlatformFileAtomic(
					paths,
					receiptPath,
					`${JSON.stringify(receipt, null, 2)}\n`,
					{ mode: 0o600, dirMode: 0o700 },
				);
			} catch (error) {
				remove({ allowIncomplete: true });
				throw error;
			}
		},
		remove,
	};
}

export function gcArchiveCache(
	paths: RuntimePaths,
	root: string,
	keep: ReadonlySet<string>,
	archiveName: "skill.tar.gz" | "source.tar.gz",
	receiptReader: ArchiveCacheReceiptReader,
	maxArchiveBytes: number,
): void {
	let keys: string[];
	try {
		const stat = lstatSync(root);
		if (!stat.isDirectory() || stat.isSymbolicLink()) return;
		keys = readdirSync(root);
	} catch (error) {
		if (error instanceof Error && "code" in error && error.code === "ENOENT") return;
		throw error;
	}
	for (const key of keys) {
		if (CACHE_KEY.test(key) && !keep.has(key)) {
			archiveCache(paths, root, key, archiveName, receiptReader, maxArchiveBytes).remove();
		}
	}
}
