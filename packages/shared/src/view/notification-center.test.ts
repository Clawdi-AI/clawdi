import { describe, expect, test } from "bun:test";
import {
	type AccountNotificationPage,
	accountNotificationsFromPages,
	formatNotificationTime,
	markNotificationPagesSeen,
	notificationBadgeLabel,
	notificationToMarkSeen,
	removeNotificationFromPages,
	unreadNotificationIds,
} from "./notification-center";

function item(id: string, read: boolean): AccountNotificationPage["items"][number] {
	return {
		id,
		kind: "billing",
		title: `Title ${id}`,
		description: "Description",
		category: "Billing",
		severity: "info",
		created_at: "2026-10-07T00:00:00Z",
		read_at: read ? "2026-10-07T01:00:00Z" : null,
	};
}

const pages: AccountNotificationPage[] = [
	{ items: [item("n-3", false), item("n-2", false)], unread_count: 3, next_cursor: "c-2" },
	{ items: [item("n-2", false), item("n-1", true), item("n-0", false)], unread_count: 3 },
];

describe("account notification read semantics", () => {
	test("opening marks everything up to the newest item once, only while unread remain", () => {
		expect(notificationToMarkSeen(pages[0], null)).toBe("n-3");
		expect(notificationToMarkSeen(pages[0], "n-3")).toBeNull();
		expect(notificationToMarkSeen({ ...pages[0], unread_count: 0 }, null)).toBeNull();
		expect(notificationToMarkSeen({ items: [], unread_count: 1 }, null)).toBeNull();
		expect(notificationToMarkSeen(undefined, null)).toBeNull();
	});

	test("marked items stay highlighted as fresh while the optimistic state reads them", () => {
		expect(unreadNotificationIds(pages)).toEqual(["n-3", "n-2", "n-2", "n-0"]);
		const seen = markNotificationPagesSeen(pages, "2026-10-07T02:00:00Z");
		expect(seen.every((page) => page.unread_count === 0)).toBe(true);
		expect(seen[1]?.items[1]?.read_at).toBe("2026-10-07T01:00:00Z");
		expect(unreadNotificationIds(seen)).toEqual([]);
	});

	test("removing an unread item lowers the unread count; removing a read one does not", () => {
		expect(removeNotificationFromPages(pages, "n-0").map((page) => page.unread_count)).toEqual([
			2, 2,
		]);
		const removedRead = removeNotificationFromPages(pages, "n-1");
		expect(removedRead.map((page) => page.unread_count)).toEqual([3, 3]);
		expect(removedRead[1]?.items.map((entry) => entry.id)).toEqual(["n-2", "n-0"]);
	});

	test("deduplicates overlapping pages and caps the badge at 9+", () => {
		expect(accountNotificationsFromPages(pages).map((entry) => entry.id)).toEqual([
			"n-3",
			"n-2",
			"n-1",
			"n-0",
		]);
		expect(notificationBadgeLabel(0)).toBeNull();
		expect(notificationBadgeLabel(3)).toBe("3");
		expect(notificationBadgeLabel(12)).toBe("9+");
	});
});

test("relative times match Intl's English output where RelativeTimeFormat is missing (Hermes)", () => {
	const now = Date.parse("2026-10-07T12:00:00Z");
	const offsets = [-10, -50, -90, -59 * 60, -2 * 3_600, -25 * 3_600, -3 * 86_400, 90, 26 * 3_600];
	const format = (seconds: number) => formatNotificationTime(new Date(now + seconds * 1_000), now);
	const intl = offsets.map(format);
	const original = Intl.RelativeTimeFormat;
	Reflect.deleteProperty(Intl, "RelativeTimeFormat");
	try {
		expect(offsets.map(format)).toEqual(intl);
	} finally {
		Object.defineProperty(Intl, "RelativeTimeFormat", {
			value: original,
			configurable: true,
			writable: true,
		});
	}
	expect(intl.slice(0, 6)).toEqual([
		"Now",
		"1 minute ago",
		"1 minute ago",
		"59 minutes ago",
		"2 hours ago",
		"yesterday",
	]);
});
