import { expect, test } from "bun:test";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { useHydrated } from "@/lib/use-hydrated";

test("keeps the server render on the hydration-safe snapshot", () => {
	function Probe() {
		return createElement("span", null, useHydrated() ? "browser" : "server");
	}

	expect(renderToStaticMarkup(createElement(Probe))).toBe("<span>server</span>");
});
