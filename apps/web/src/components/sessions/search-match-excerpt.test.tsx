import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { SessionSearchMatchExcerpt } from "@/components/sessions/search-match-excerpt";

const anchor = { kind: "event_seq" as const, position: 4, revision: "events:revision" };

describe("SessionSearchMatchExcerpt", () => {
	test("highlights a contiguous phrase without hiding the surrounding excerpt", () => {
		const markup = renderToStaticMarkup(
			createElement(SessionSearchMatchExcerpt, {
				match: { role: "assistant", excerpt: "Fixed the authentication timeout", anchor },
				query: "authentication timeout",
			}),
		);

		expect(markup).toContain("Fixed the ");
		expect(markup).toContain(">authentication timeout</mark>");
	});

	test("renders query text as escaped content", () => {
		const markup = renderToStaticMarkup(
			createElement(SessionSearchMatchExcerpt, {
				match: { role: "user", excerpt: "Find <script> safely", anchor },
				query: "<script>",
			}),
		);

		expect(markup).toContain("&lt;script&gt;");
		expect(markup).not.toContain("<script>");
	});
});
