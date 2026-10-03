export interface ParsedKey {
	key: string;
	value: string;
	line?: number;
	rawKey?: string;
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

export interface KeyImportOptions {
	/** Preserve dotenv names for APIs whose field names are case-sensitive. */
	preserveKeyCase?: boolean;
}

export const REQUEST_FIELD_NAME_RE = /^[A-Za-z0-9_.-]{1,200}$/;
export const MAX_ENV_IMPORT_BYTES = 4 * 1024 * 1024;

/** Dotenv text only: never evaluate substitutions or accept JSON. */
export function parseVaultRequestEnv(raw: string): ParsedKeyImport {
	if (new TextEncoder().encode(raw).length > MAX_ENV_IMPORT_BYTES) {
		return { entries: [], errors: ["Import must be at most 4 MiB."] };
	}
	const parsed = parseEnvKeyImport(raw, { preserveKeyCase: true });
	if (parsed.errors.length)
		return {
			entries: [],
			errors: parsed.errors.map((error) => {
				const line = /^Line \d+/.exec(error)?.[0];
				return `${line ?? "Import"}: invalid assignment or duplicate field.`;
			}),
		};
	if (
		parsed.entries.length > 32 ||
		parsed.entries.some(({ value }) => !value || [...value].length > 65536 || value.includes("\0"))
	) {
		return {
			entries: [],
			errors: [
				"Use at most 32 fields with nonempty text values of at most 65536 characters and no NUL characters.",
			],
		};
	}
	return parsed;
}

const KEY_NAME_RE = /^[A-Z0-9_]+$/;
const KEY_NAME_RULE =
	"Key names can use only letters, numbers, and underscores (_). Hyphens, spaces, and other characters aren't allowed.";

export function parseVaultKeyImport(raw: string, options: KeyImportOptions = {}): ParsedKeyImport {
	const text = raw.trim();
	if (!text) return { entries: [], errors: [] };

	if (text.startsWith("{")) {
		return parseJsonKeyImport(text, options);
	}
	return parseEnvKeyImport(raw, options);
}

function parseJsonKeyImport(text: string, options: KeyImportOptions): ParsedKeyImport {
	try {
		const parsed = JSON.parse(text) as unknown;
		if (!parsed || Array.isArray(parsed) || typeof parsed !== "object") {
			return { entries: [], errors: ["JSON import must be an object with key-value pairs."] };
		}
		const entries: ParsedKey[] = [];
		const errors: string[] = [];
		for (const [rawKey, rawValue] of Object.entries(parsed)) {
			const key = normalizeImportKey(rawKey, options.preserveKeyCase);
			if (!(options.preserveKeyCase ? REQUEST_FIELD_NAME_RE.test(key) : KEY_NAME_RE.test(key))) {
				errors.push(`Invalid key "${rawKey}". ${KEY_NAME_RULE}`);
				continue;
			}
			if (rawValue !== null && typeof rawValue === "object") {
				errors.push(`Key "${rawKey}" has a nested value. Use a string, number, or boolean.`);
				continue;
			}
			entries.push({ key, rawKey, value: rawValue == null ? "" : String(rawValue) });
		}
		return withDuplicateErrors(entries, errors);
	} catch {
		return { entries: [], errors: ['Invalid JSON. Paste a flat object like {"API_KEY":"…"}.'] };
	}
}

function parseEnvKeyImport(raw: string, options: KeyImportOptions): ParsedKeyImport {
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
		const key = normalizeImportKey(rawKey, options.preserveKeyCase);
		if (!(options.preserveKeyCase ? REQUEST_FIELD_NAME_RE.test(key) : KEY_NAME_RE.test(key))) {
			errors.push(`Line ${lineNumber}: invalid key "${rawKey}". ${KEY_NAME_RULE}`);
			return;
		}
		const valueSource = source.slice(equalsIndex + 1);
		const value = parseEnvValue(valueSource);
		if (value === null) {
			errors.push(`Line ${lineNumber}: unterminated quoted value.`);
			return;
		}
		entries.push({
			key,
			rawKey,
			value,
			line: lineNumber,
		});
	});
	return withDuplicateErrors(entries, errors);
}

function parseEnvValue(rawValue: string): string | null {
	const value = rawValue.trim();
	const quote = value[0];
	if (quote !== '"' && quote !== "'") return value.replace(/\s+#.*$/, "").trimEnd();
	let result = "";
	for (let i = 1; i < value.length; i++) {
		const char = value[i];
		if (char === quote) {
			const tail = value.slice(i + 1);
			return /^\s*(?:#.*)?$/.test(tail) ? result : null;
		}
		if (char === "\\" && quote === '"') {
			const next = value[i + 1];
			const decoded: Record<string, string> = { n: "\n", r: "\r", t: "\t", '"': '"', "\\": "\\" };
			if (next !== undefined && decoded[next] !== undefined) {
				result += decoded[next];
				i++;
				continue;
			}
		}
		result += char;
	}
	return null;
}

function normalizeImportKey(rawKey: string, preserveCase = false) {
	return preserveCase ? rawKey.trim() : rawKey.trim().toUpperCase();
}

function withDuplicateErrors(entries: ParsedKey[], errors: string[]): ParsedKeyImport {
	const seen = new Map<string, ParsedKey>();
	const unique: ParsedKey[] = [];
	for (const entry of entries) {
		const firstSeen = seen.get(entry.key);
		if (firstSeen !== undefined) {
			const where = entry.line !== undefined ? `Line ${entry.line}` : "JSON import";
			const firstName = firstSeen.rawKey ?? firstSeen.key;
			const duplicateName = entry.rawKey ?? entry.key;
			errors.push(
				`${where}: duplicate key "${duplicateName}" (same as "${firstName}" after normalization to "${entry.key}").`,
			);
			continue;
		}
		seen.set(entry.key, entry);
		unique.push(entry);
	}
	return { entries: errors.length > 0 ? [] : unique, errors };
}
