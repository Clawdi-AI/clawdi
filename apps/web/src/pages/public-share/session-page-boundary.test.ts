import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";

const functionsSource = readFileSync(
	new URL("./session-page.functions.ts", import.meta.url),
	"utf8",
);
const pageSource = readFileSync(new URL("./session-page.tsx", import.meta.url), "utf8");
const routeSource = readFileSync(new URL("../../routes/s/$id.tsx", import.meta.url), "utf8");
const protectedRouteSource = readFileSync(
	new URL("../../routes/_protected.tsx", import.meta.url),
	"utf8",
);

describe("server hydration boundaries", () => {
	test("keeps identity-dependent reads and response policy in one server function", () => {
		expect(functionsSource).toContain('setResponseHeader("cache-control", "no-store")');
		expect(functionsSource).toContain("await auth()");
		expect(functionsSource).toContain('api.GET("/v1/public/sessions/{session_id}"');
		expect(functionsSource).toContain('api.GET("/v1/public/sessions/{session_id}/messages"');
		expect(functionsSource).toContain(
			'return { kind: "ok", share: shareResult.data, messagesPage }',
		);
		expect(protectedRouteSource).toContain(
			'const getAuthState = createServerFn({ method: "GET" }).handler',
		);
		expect(protectedRouteSource).toContain('setResponseHeader("cache-control", "no-store")');
	});

	test("renders synchronously from dehydrated route data", () => {
		expect(routeSource).toContain('if (result.kind === "not-found") throw notFound()');
		expect(routeSource).toContain("Route.useLoaderData()");
		expect(pageSource).toContain("export default function PublicSharePage");
		expect(pageSource).not.toContain("export default async function PublicSharePage");
		expect(pageSource).not.toContain("getPublicShareData");
		expect(pageSource).not.toContain("auth()");
	});
});
