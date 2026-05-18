import { afterEach, describe, expect, it } from "bun:test";
import { ApiClient } from "../src/lib/api-client";
import { fetchDefaultProjectId } from "../src/lib/select-adapter";
import { jsonResponse, mockFetch } from "./commands/helpers";

describe("fetchDefaultProjectId", () => {
	let restoreFetch: (() => void) | undefined;

	afterEach(() => {
		restoreFetch?.();
		restoreFetch = undefined;
	});

	it("reads non-ok response bodies once and reports the HTTP status", async () => {
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/api/projects/default",
				response: () => jsonResponse({ detail: "boom" }, 500),
			},
		]);
		restoreFetch = restore;

		await expect(fetchDefaultProjectId(new ApiClient({ requireAuth: false }))).rejects.toThrow(
			"HTTP 500",
		);
	});

	it("accepts legacy non-ok project_id payloads without re-reading the body", async () => {
		const { restore } = mockFetch([
			{
				method: "GET",
				path: "/api/projects/default",
				response: () => jsonResponse({ project_id: "project-legacy" }, 400),
			},
		]);
		restoreFetch = restore;

		await expect(fetchDefaultProjectId(new ApiClient({ requireAuth: false }))).resolves.toBe(
			"project-legacy",
		);
	});
});
