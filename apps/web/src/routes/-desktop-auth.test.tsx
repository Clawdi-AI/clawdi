import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DesktopAuthPage } from "./desktop-auth";

test("retired Desktop sign-in renders browser and upgrade guidance without Clerk", () => {
	const markup = renderToStaticMarkup(createElement(DesktopAuthPage));
	expect(markup).toContain("Open Clawdi in your browser");
	expect(markup).toContain("Update Clawdi Desktop");
	expect(markup).toContain('href="https://cloud.clawdi.ai"');
	expect(markup).toContain('target="_blank"');
	expect(markup).toContain('rel="noopener noreferrer"');
});
