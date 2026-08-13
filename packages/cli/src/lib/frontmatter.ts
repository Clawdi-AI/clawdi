import { parse as parseYaml } from "yaml";

export class SkillTextValidationError extends Error {
	constructor() {
		super("SKILL.md must not contain NUL characters, including YAML-decoded escapes.");
		this.name = "SkillTextValidationError";
	}
}

/** Reject text that the server cannot persist without changing its content. */
export function assertUploadableSkillText(raw: string): void {
	if (raw.includes("\0")) throw new SkillTextValidationError();

	const match = raw.match(/^---\s*\n(.*?)\n---\s*\n/s);
	if (!match) return;

	let parsed: unknown;
	try {
		parsed = parseYaml(match[1] ?? "", { mapAsMap: true, merge: true, uniqueKeys: false });
	} catch {
		// The server accepts malformed frontmatter as an empty metadata block.
		return;
	}
	if (!(parsed instanceof Map)) return;

	for (const [key, value] of parsed) {
		if (typeof key !== "string") continue;
		if (key.includes("\0")) throw new SkillTextValidationError();
		if (typeof value === "string" && value.includes("\0")) throw new SkillTextValidationError();
	}
}

/**
 * Minimal SKILL.md frontmatter parser.
 *
 * Only supports:
 *   - YAML-style `---` delimiters
 *   - `key: value` pairs, one per line, all string values
 *   - `key: "double"` and `key: 'single'` quoted values (de-quoted)
 *
 * Deliberately does NOT support `---js` / `---javascript` to avoid the
 * `gray-matter` JS-eval RCE path. Also does NOT support nested objects
 * or arrays — if your skill frontmatter needs those, add a proper YAML
 * parser rather than extending this function.
 */
export function parseFrontmatter(raw: string): {
	data: Record<string, string>;
	content: string;
} {
	const match = raw.match(/^---\r?\n([\s\S]*?)\r?\n---\r?\n?([\s\S]*)$/);
	if (!match) return { data: {}, content: raw };

	const body = match[1] ?? "";
	const data: Record<string, string> = {};

	for (const rawLine of body.split(/\r?\n/)) {
		const line = rawLine.trim();
		if (!line || line.startsWith("#")) continue;

		const colon = line.indexOf(":");
		if (colon === -1) continue;

		const key = line.slice(0, colon).trim();
		let value = line.slice(colon + 1).trim();

		if (!key) continue;

		// Strip trailing comment (only if not inside a quoted string)
		if (!value.startsWith('"') && !value.startsWith("'")) {
			const hashIdx = value.indexOf(" #");
			if (hashIdx !== -1) value = value.slice(0, hashIdx).trim();
		}

		// De-quote
		if (
			(value.startsWith('"') && value.endsWith('"')) ||
			(value.startsWith("'") && value.endsWith("'"))
		) {
			value = value.slice(1, -1);
		}

		data[key] = value;
	}

	return { data, content: match[2] ?? "" };
}
