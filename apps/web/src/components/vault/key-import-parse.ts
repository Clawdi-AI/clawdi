export interface ParsedKey {
	key: string;
	value: string;
	line?: number;
}

export interface KeyImportSummary {
	created: number;
	updated: number;
	skipped: number;
}

export interface ParsedKeyImport {
	entries: ParsedKey[];
	errors: string[];
}

const KEY_NAME_RE = /^[A-Z0-9_]+$/;

export function parseVaultKeyImport(raw: string): ParsedKeyImport {
	const text = raw.trim();
	if (!text) return { entries: [], errors: [] };

	if (text.startsWith("{")) {
		return parseJsonKeyImport(text);
	}
	return parseEnvKeyImport(raw);
}

function parseJsonKeyImport(text: string): ParsedKeyImport {
	try {
		const parsed = JSON.parse(text) as unknown;
		if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
			return { entries: [], errors: ["JSON import must be an object with key-value pairs."] };
		}
		const entries: ParsedKey[] = [];
		const errors: string[] = [];
		for (const [rawKey, rawValue] of Object.entries(parsed)) {
			const key = normalizeImportKey(rawKey);
			if (!KEY_NAME_RE.test(key)) {
				errors.push(`Invalid key "${rawKey}". Use letters, numbers, and underscores.`);
				continue;
			}
			if (rawValue !== null && typeof rawValue === "object") {
				errors.push(`Key "${rawKey}" has a nested value. Use a string, number, or boolean.`);
				continue;
			}
			entries.push({ key, value: rawValue == null ? "" : String(rawValue) });
		}
		return withDuplicateErrors(entries, errors);
	} catch {
		return { entries: [], errors: ['Invalid JSON. Paste a flat object like {"API_KEY":"..."}.'] };
	}
}

function parseEnvKeyImport(raw: string): ParsedKeyImport {
	const entries: ParsedKey[] = [];
	const errors: string[] = [];
	raw.split(/\r?\n/).forEach((line, index) => {
		const lineNumber = index + 1;
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) return;
		const source = trimmed.startsWith("export ") ? trimmed.slice("export ".length).trim() : trimmed;
		const equalsIndex = source.indexOf("=");
		if (equalsIndex < 1) {
			errors.push(`Line ${lineNumber}: expected KEY=value.`);
			return;
		}
		const rawKey = source.slice(0, equalsIndex).trim();
		const key = normalizeImportKey(rawKey);
		if (!KEY_NAME_RE.test(key)) {
			errors.push(`Line ${lineNumber}: invalid key "${rawKey}".`);
			return;
		}
		entries.push({
			key,
			value: parseEnvValue(source.slice(equalsIndex + 1)),
			line: lineNumber,
		});
	});
	return withDuplicateErrors(entries, errors);
}

function parseEnvValue(rawValue: string) {
	const value = rawValue.trim();
	if (
		(value.startsWith('"') && value.endsWith('"')) ||
		(value.startsWith("'") && value.endsWith("'"))
	) {
		const unquoted = value.slice(1, -1);
		if (value.startsWith('"')) {
			return unquoted
				.replace(/\\n/g, "\n")
				.replace(/\\r/g, "\r")
				.replace(/\\t/g, "\t")
				.replace(/\\"/g, '"')
				.replace(/\\\\/g, "\\");
		}
		return unquoted;
	}
	return value.replace(/\s+#.*$/, "").trim();
}

function normalizeImportKey(rawKey: string) {
	return rawKey.trim().toUpperCase();
}

function withDuplicateErrors(entries: ParsedKey[], errors: string[]): ParsedKeyImport {
	const seen = new Map<string, number | "json">();
	const unique: ParsedKey[] = [];
	for (const entry of entries) {
		const firstSeen = seen.get(entry.key);
		if (firstSeen !== undefined) {
			const where =
				entry.line !== undefined
					? `Line ${entry.line}`
					: firstSeen === "json"
						? "JSON import"
						: `Line ${firstSeen}`;
			errors.push(`${where}: duplicate key "${entry.key}".`);
			continue;
		}
		seen.set(entry.key, entry.line ?? "json");
		unique.push(entry);
	}
	return { entries: errors.length > 0 ? [] : unique, errors };
}
