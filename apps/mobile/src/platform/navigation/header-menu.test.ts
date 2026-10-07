import { describe, expect, test } from "bun:test";
import { headerMenuGroups } from "@/platform/navigation/header-menu";

const action = (id: string, selected?: boolean) => ({ id, label: id, selected, onPress: () => {} });

describe("headerMenuGroups", () => {
	test("puts untitled root items before titled inline sections", () => {
		const groups = headerMenuGroups({
			label: "Options",
			items: [action("refresh")],
			sections: [{ id: "profile", title: "Profile", items: [action("all", true)] }],
		});
		expect(groups.map((group) => [group.id, group.title])).toEqual([
			["items", undefined],
			["profile", "Profile"],
		]);
		expect(groups[1]?.items[0]?.selected).toBe(true);
	});

	test("drops empty groups so no menu starts with or doubles a separator", () => {
		const groups = headerMenuGroups({
			label: "Options",
			sections: [
				{ id: "sort", title: "Sort by", items: [action("started_at")] },
				{ id: "empty", title: "Empty", items: [] },
				{ id: "order", title: "Order", items: [action("asc")] },
			],
		});
		// Android draws a divider between consecutive groups; iOS nests each titled group inline.
		expect(groups.map((group) => group.id)).toEqual(["sort", "order"]);
	});
});
