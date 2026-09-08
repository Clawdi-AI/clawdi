import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const functionsSource = readFileSync(
	new URL("./session-page.functions.ts", import.meta.url),
	"utf8",
);
const protectedRouteSource = readFileSync(
	new URL("../../routes/_protected.tsx", import.meta.url),
	"utf8",
);

describe("server hydration boundaries", () => {
	test("keeps authenticated server reads uncacheable", () => {
		expect(functionsSource).toContain('setResponseHeader("cache-control", "no-store")');
		expect(functionsSource).toContain("await auth()");
		expect(protectedRouteSource).toContain('setResponseHeader("cache-control", "no-store")');
	});
});
