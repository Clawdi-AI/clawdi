import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const source = readFileSync(new URL("./session-page.tsx", import.meta.url), "utf8");

describe("public session server boundary", () => {
	test("keeps auth and both backend reads inside one server function", () => {
		const serverFnStart = source.indexOf("const getPublicShareData = createServerFn");
		const pageStart = source.indexOf("export default async function PublicSharePage");

		expect(serverFnStart).toBeGreaterThan(-1);
		expect(pageStart).toBeGreaterThan(serverFnStart);

		const serverFn = source.slice(serverFnStart, pageStart);
		const page = source.slice(pageStart);

		expect(serverFn).toContain("await auth()");
		expect(serverFn).toContain('api.GET("/v1/public/sessions/{session_id}"');
		expect(serverFn).toContain('api.GET("/v1/public/sessions/{session_id}/messages"');
		expect(serverFn).toContain('return { kind: "ok", share: shareResult.data, messagesPage }');
		expect(page).toContain("await getPublicShareData({ data: { sessionId: id } })");
		expect(page).not.toContain("auth()");
		expect(page).not.toMatch(/\btoken\b/);
	});
});
