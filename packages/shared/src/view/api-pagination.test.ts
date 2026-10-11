import { describe, expect, test } from "bun:test";
import { fetchAllPages, nextBillingCursor } from "./api-pagination";

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

describe("nextBillingCursor", () => {
	test("continues only with a complete server cursor and keeps it opaque", () => {
		const first = { has_more: true, next_cursor: "a &+/?" };
		expect(nextBillingCursor(first, [first])).toBe("a &+/?");
		expect(nextBillingCursor({ has_more: true, next_cursor: null }, [])).toBeUndefined();
		expect(nextBillingCursor({ has_more: true, next_cursor: " " }, [])).toBeUndefined();
		expect(nextBillingCursor({ has_more: false, next_cursor: "b" }, [])).toBeUndefined();
	});

	test("stops when the server repeats an earlier cursor", () => {
		const first = { has_more: true, next_cursor: "a" };
		expect(
			nextBillingCursor(first, [first, { has_more: true, next_cursor: "b" }, first]),
		).toBeUndefined();
	});
});
