import { readFileSync } from "node:fs";
import JSON5 from "json5";
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
