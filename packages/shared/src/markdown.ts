import type { Nodes, Root } from "mdast";
import remarkBreaks from "remark-breaks";
import remarkGfm from "remark-gfm";
import remarkParse from "remark-parse";
import { unified } from "unified";

export type { Nodes as MarkdownNode, Root as MarkdownRoot } from "mdast";
/** Keep Web/native syntax identical; neither renderer executes raw HTML. */
export const markdownPlugins = [remarkGfm, remarkBreaks] as const;
const parser = unified().use(remarkParse).use(markdownPlugins[0]).use(markdownPlugins[1]).freeze();

function renderable(root: Root): boolean {
	const pending: { node: Nodes; depth: number }[] = [{ node: root, depth: 0 }];
	let count = 0;
	while (pending.length) {
		const entry = pending.pop();
		if (!entry) break;
		if (++count > 5000 || entry.depth > 40) return false;
		if ("children" in entry.node)
			for (const child of entry.node.children)
				pending.push({ node: child, depth: entry.depth + 1 });
	}
	return true;
}

/** Null means render the original text, never silently discard a large payload. */
export function parseDisplayMarkdown(source: string): Root | null {
	if (source.length > 120_000) return null;
	try {
		const root = parser.parse(source);
		if (!renderable(root)) return null;
		// Both shared plugins transform the supplied mdast in place.
		parser.runSync(root);
		return renderable(root) ? root : null;
	} catch {
		return null;
	}
}

/** CommonMark definitions are document-wide; the first definition wins. */
export function markdownReferenceUrls(tree: Root): Map<string, string> {
	const result = new Map<string, string>();
	const pending: Nodes[] = [tree];
	while (pending.length) {
		const node = pending.pop();
		if (!node) break;
		if (node.type === "definition") {
			const key = node.identifier.toLowerCase();
			if (!result.has(key)) result.set(key, node.url);
		}
		if ("children" in node) pending.push(...[...node.children].reverse());
	}
	return result;
}

/** Native content has no trusted document base. Never interpret relative or app-scheme links. */
export function markdownExternalUrl(value: string): string | null {
	if (
		value !== value.trim() ||
		Array.from(value).some(
			(character) =>
				character.charCodeAt(0) <= 32 || character.charCodeAt(0) === 127 || character === "\\",
		)
	)
		return null;
	try {
		const url = new URL(value);
		if (
			!["https:", "http:"].includes(url.protocol) ||
			!url.hostname ||
			url.username ||
			url.password
		)
			return null;
		return url.href;
	} catch {
		return null;
	}
}
