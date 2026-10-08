import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { DesktopAuthPage } from "./desktop-auth";

test("normal browsers render refusal without loading Clerk or consuming URL tickets", () => {
	const markup = renderToStaticMarkup(createElement(DesktopAuthPage));
	expect(markup).toContain("Open this page in Clawdi Desktop");
	expect(markup).toContain("Desktop sign-in is available only inside the Clawdi app.");
	expect(markup).not.toContain("Signing in to Clawdi");
});
