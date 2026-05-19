export function parseDotenv(content: string): Array<[string, string]> {
	const entries: Array<[string, string]> = [];
	for (const line of content.split(/\r?\n/)) {
		const trimmed = line.trim();
		if (!trimmed || trimmed.startsWith("#")) continue;
		const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)$/.exec(trimmed);
		if (!match) continue;
		entries.push([match[1], parseDotenvValue(match[2].trim())]);
	}
	return entries;
}

function parseDotenvValue(value: string): string {
	if (value.startsWith('"')) {
		const end = closingQuoteIndex(value, '"');
		if (end !== -1) {
			return value.slice(1, end).replace(/\\n/g, "\n").replace(/\\"/g, '"').replace(/\\\\/g, "\\");
		}
	}
	if (value.startsWith("'")) {
		const end = closingQuoteIndex(value, "'");
		if (end !== -1) {
			return value.slice(1, end);
		}
	}
	const hashIndex = value.indexOf(" #");
	return hashIndex === -1 ? value : value.slice(0, hashIndex).trimEnd();
}

function closingQuoteIndex(value: string, quote: '"' | "'"): number {
	for (let index = 1; index < value.length; index += 1) {
		if (value[index] !== quote) continue;
		if (quote === '"' && isEscaped(value, index)) continue;
		return index;
	}
	return -1;
}

function isEscaped(value: string, index: number): boolean {
	let slashes = 0;
	for (let cursor = index - 1; cursor >= 0 && value[cursor] === "\\"; cursor -= 1) {
		slashes += 1;
	}
	return slashes % 2 === 1;
}
