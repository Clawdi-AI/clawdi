import { existsSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import type { CacheStore } from "baileys";

type CacheEntry = {
	expiresAt: number;
	value: unknown;
};

export class DurableJsonCache implements CacheStore {
	private readonly entries = new Map<string, CacheEntry>();

	constructor(
		private readonly path: string,
		private readonly ttlSeconds: number,
	) {
		if (!Number.isFinite(ttlSeconds) || ttlSeconds <= 0) {
			throw new Error("durable cache ttlSeconds must be positive");
		}
		this.load();
	}

	get<T>(key: string): T | undefined {
		const entry = this.entries.get(key);
		if (!entry) return undefined;
		if (entry.expiresAt <= Date.now()) {
			this.entries.delete(key);
			this.persist();
			return undefined;
		}
		return entry.value as T;
	}

	set<T>(key: string, value: T): void {
		this.entries.set(key, {
			expiresAt: Date.now() + this.ttlSeconds * 1000,
			value,
		});
		this.persist();
	}

	del(key: string): void {
		if (!this.entries.delete(key)) return;
		this.persist();
	}

	flushAll(): void {
		this.entries.clear();
		this.persist();
	}

	private load(): void {
		if (!existsSync(this.path)) return;
		const parsed: unknown = JSON.parse(readFileSync(this.path, "utf-8"));
		if (!isRecord(parsed)) throw new Error("durable cache file must contain an object");
		const now = Date.now();
		for (const [key, rawEntry] of Object.entries(parsed)) {
			if (!isRecord(rawEntry) || typeof rawEntry.expiresAt !== "number") continue;
			if (rawEntry.expiresAt <= now) continue;
			this.entries.set(key, { expiresAt: rawEntry.expiresAt, value: rawEntry.value });
		}
	}

	private persist(): void {
		const serialized = Object.fromEntries(
			[...this.entries.entries()].sort(([left], [right]) => left.localeCompare(right)),
		);
		const temporaryPath = `${this.path}.${process.pid}.tmp`;
		writeFileSync(temporaryPath, `${JSON.stringify(serialized)}\n`, {
			encoding: "utf-8",
			mode: 0o600,
		});
		renameSync(temporaryPath, this.path);
	}
}

function isRecord(value: unknown): value is Record<string, unknown> {
	return typeof value === "object" && value !== null && !Array.isArray(value);
}
