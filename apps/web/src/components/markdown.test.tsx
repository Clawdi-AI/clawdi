import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { Markdown } from "@/components/markdown";

describe("Markdown search highlighting", () => {
	test("highlights visible text without changing fenced code", () => {
		const markup = renderToStaticMarkup(
			createElement(Markdown, {
				content: "Fixed authentication timeout.\n\n```text\nauthentication timeout\n```",
				highlightQuery: "authentication timeout",
			}),
		);

		expect(markup.match(/<mark/g)).toHaveLength(1);
		expect(markup).toContain(">authentication timeout</mark>");
		expect(markup).toContain("authentication timeout\n</code>");
	});
});
