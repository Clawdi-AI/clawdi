import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import JSON5 from "json5";
import { readPrivateFileEvidence } from "../lib/private-file";
import { recordValue } from "./manifest-shared";

/** Includes need the native reader; plain JSON5 can authorize exact local reuse. */
export function readPlainOpenClawConfig(configPath: string): Record<string, unknown> | null {
	try {
		const config = recordValue(JSON5.parse(readFileSync(configPath, "utf8")) as unknown);
		const hasInclude = (value: unknown): boolean => {
			const record = recordValue(value);
			return Array.isArray(value)
				? value.some(hasInclude)
				: record !== null &&
						(Object.hasOwn(record, "$include") || Object.values(record).some(hasInclude));
		};
		return config && !hasInclude(config) ? config : null;
	} catch {
		return null;
	}
}

/** Scan references in JSON5 and include documents without authorizing local skips. */
export function visitOpenClawConfigDocuments(
	configPath: string,
	visit: (value: Record<string, unknown>) => void,
	depth = 0,
): void {
	if (depth > 10) throw new Error("OpenClaw config include depth exceeded");
	const evidence = readPrivateFileEvidence(configPath, {
		uid: process.geteuid?.() ?? 0,
		gid: process.getegid?.() ?? 0,
		modes: [0o400, 0o600, 0o644],
		maxBytes: 2 * 1024 * 1024,
	});
	let config: Record<string, unknown> | null;
	try {
		config = recordValue(JSON5.parse(evidence.content.toString("utf8")) as unknown);
		evidence.assertCurrent();
	} finally {
		evidence.close();
	}
	if (!config) throw new Error("OpenClaw config document must be an object");
	const walk = (value: unknown): void => {
		if (Array.isArray(value)) {
			for (const child of value) walk(child);
			return;
		}
		const record = recordValue(value);
		if (!record) return;
		visit(record);
		if (Object.hasOwn(record, "$include")) {
			const includes = Array.isArray(record.$include) ? record.$include : [record.$include];
			for (const include of includes) {
				if (typeof include !== "string") throw new Error("Invalid OpenClaw config include");
				visitOpenClawConfigDocuments(resolve(dirname(configPath), include), visit, depth + 1);
			}
		}
		for (const [key, child] of Object.entries(record)) if (key !== "$include") walk(child);
	};
	walk(config);
}
