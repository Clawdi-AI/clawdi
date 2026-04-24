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
