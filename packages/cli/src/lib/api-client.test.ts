import { describe, expect, it } from "bun:test";
import { ApiClient } from "./api-client";

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
});
