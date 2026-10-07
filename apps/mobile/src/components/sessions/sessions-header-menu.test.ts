import { describe, expect, mock, test } from "bun:test";
import type { SessionListQuery } from "@clawdi/shared/api";
import { sessionsHeaderMenu } from "@/components/sessions/sessions-header-menu";

const t = (key: string) => key;

function menu(overrides: Partial<Parameters<typeof sessionsHeaderMenu>[0]> = {}) {
	return sessionsHeaderMenu({
		t,
		sort: "last_activity_at",
		order: "desc",
		searchReady: false,
		profileSection: null,
		onChange: () => {},
		...overrides,
	});
}

function checked(id: string, result = menu()) {
	return result.sections
		?.find((section) => section.id === id)
		?.items.filter((item) => item.selected)
		.map((item) => item.id);
}

describe("sessionsHeaderMenu", () => {
	test("checks exactly the current sort and order", () => {
		expect(checked("sort")).toEqual(["last_activity_at"]);
		expect(checked("order")).toEqual(["desc"]);
		const result = menu({ sort: "message_count", order: "asc" });
		expect(checked("sort", result)).toEqual(["message_count"]);
		expect(checked("order", result)).toEqual(["asc"]);
	});

	test("offers relevance only for a ready search", () => {
		const sorts = (result: ReturnType<typeof menu>) =>
			result.sections?.[0]?.items.map((item) => item.id);
		expect(sorts(menu())).not.toContain("relevance");
		expect(sorts(menu({ searchReady: true, sort: "relevance" }))).toContain("relevance");
		expect(checked("sort", menu({ searchReady: true, sort: "relevance" }))).toEqual(["relevance"]);
	});

	test("applies picks and appends the Agent profile section last", () => {
		const onChange = mock((_values: SessionListQuery) => {});
		const profileSection = { id: "profile", title: "Profile", items: [] };
		const result = menu({ onChange, profileSection });
		expect(result.sections?.map((section) => section.id)).toEqual(["sort", "order", "profile"]);
		result.sections?.[0]?.items.find((item) => item.id === "tokens")?.onPress();
		result.sections?.[1]?.items.find((item) => item.id === "asc")?.onPress();
		expect(onChange.mock.calls).toEqual([[{ sort: "tokens" }], [{ order: "asc" }]]);
	});
});
