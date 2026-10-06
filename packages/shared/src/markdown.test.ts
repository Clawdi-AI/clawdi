import { expect, test } from "bun:test";
import { markdownExternalUrl, markdownReferenceUrls, parseDisplayMarkdown } from "./markdown";

test("display parsing preserves GFM tables, tasks, references and literal HTML without executing it", () => {
	const tree = parseDisplayMarkdown(
		"# Title\n\n- [x] **Done**\n\n| Name | Value |\n| --- | --- |\n| a | `b` |\n\n[docs][ref]\n\n[ref]: https://example.test/docs\n\n<script>alert(1)</script>",
	);
	expect(tree?.children.map((node) => node.type)).toEqual([
		"heading",
		"list",
		"table",
		"paragraph",
		"definition",
		"html",
	]);
	const list = tree?.children.find((node) => node.type === "list");
	expect(list?.children[0]?.checked).toBe(true);
	const definition = tree?.children.find((node) => node.type === "definition");
	expect(definition?.url).toBe("https://example.test/docs");
	const html = tree?.children.find((node) => node.type === "html");
	expect(html?.value).toBe("<script>alert(1)</script>");
	const references = parseDisplayMarkdown(
		"> [ref]: https://first.test\n\n[ref]: https://second.test\n\n[link][ref]",
	);
	if (!references) throw new Error("Expected a document");
	expect(markdownReferenceUrls(references).get("ref")).toBe("https://first.test");
});

test("native links never resolve app schemes, credentials, relative paths or whitespace ambiguity", () => {
	for (const url of [
		"javascript:alert(1)",
		"data:text/html,hello",
		"file:///secret",
		"clawdi://settings",
		"//example.test",
		"/relative",
		"https://user:pass@example.test",
		"https://example.test\\@evil.test",
		"https://example.test\n",
		" https://example.test",
	])
		expect(markdownExternalUrl(url)).toBeNull();
	expect(markdownExternalUrl("https://example.test/a?q=1#section")).toBe(
		"https://example.test/a?q=1#section",
	);
});

test("oversized and deeply nested content asks the renderer to preserve plain text", () => {
	expect(parseDisplayMarkdown("x".repeat(120001))).toBeNull();
	expect(parseDisplayMarkdown(`${"> ".repeat(45)}nested`)).toBeNull();
	const tree = parseDisplayMarkdown("first\nsecond");
	const paragraph = tree?.children[0];
	expect(
		paragraph?.type === "paragraph" && paragraph.children.some((node) => node.type === "break"),
	).toBe(true);
});
