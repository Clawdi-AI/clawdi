import { describe, expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { AppNotFound } from "./app-not-found";

describe("AppNotFound", () => {
	test("offers working exits from the missing page", () => {
		const markup = renderToStaticMarkup(createElement(AppNotFound));

		expect(markup).toContain('href="/"');
		expect(markup).toContain("Back to dashboard");
		expect(markup).toContain('href="https://clawdi.ai"');
	});
});
