import { afterEach, describe, expect, it } from "bun:test";
import { ApiClient } from "./api-client";
import { tarSingleFile } from "./tar";

const originalFetch = globalThis.fetch;

afterEach(() => {
	globalThis.fetch = originalFetch;
});

describe("ApiClient.uploadSkill", () => {
	it("rejects invalid skill_key before building a multipart request", async () => {
		const api = new ApiClient({ requireAuth: false });

		await expect(
			api.uploadSkill(
				"00000000-0000-0000-0000-000000000000",
				".system",
				Buffer.from("not a tar"),
				".system.tar.gz",
			),
		).rejects.toThrow('Invalid skill_key: ".system"');
	});

	it("rejects literal and YAML-decoded NUL text before sending multipart", async () => {
		let fetchCalls = 0;
		globalThis.fetch = Object.assign(
			async () => {
				fetchCalls++;
				return new Response("unexpected");
			},
			{ preconnect: originalFetch.preconnect },
		);

		const api = new ApiClient({ requireAuth: false });
		const cases = [
			{ key: "literal-nul", raw: "# Body\0\n" },
			{
				key: "decoded-nul",
				raw: '---\nname: "invalid\\0name"\ndescription: metadata\n---\n# Body\n',
			},
		];
		expect(Buffer.from(cases[1]?.raw ?? "").includes(0)).toBe(false);
		for (const { key, raw } of cases) {
			await expect(
				api.uploadSkill(
					"00000000-0000-0000-0000-000000000000",
					key,
					await tarSingleFile(key, raw),
					"skill.tar.gz",
				),
			).rejects.toThrow("SKILL.md must not contain NUL characters");
		}
		expect(fetchCalls).toBe(0);
	});
});
