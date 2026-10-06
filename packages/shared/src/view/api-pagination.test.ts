import { describe, expect, test } from "bun:test";
import { fetchAllPages } from "./api-pagination";

describe("fetchAllPages", () => {
	test("walks pages until total is reached", async () => {
		const calls: number[] = [];
		const result = await fetchAllPages(
			async (page, pageSize) => {
				calls.push(page);
				return {
					items: page === 1 ? [1, 2] : [3],
					total: 3,
					page,
					page_size: pageSize,
				};
			},
			{ pageSize: 2, resourceName: "numbers" },
		);

		expect(calls).toEqual([1, 2]);
		expect(result.items).toEqual([1, 2, 3]);
		expect(result.total).toBe(3);
		expect(result.page_size).toBe(2);
	});

	test("throws instead of silently truncating after the page guard", async () => {
		await expect(
			fetchAllPages(
				async (page, pageSize) => ({
					items: [page],
					total: 10,
					page,
					page_size: pageSize,
				}),
				{ pageSize: 1, maxPages: 2, resourceName: "numbers" },
			),
		).rejects.toThrow("Too many numbers pages");
	});
});
