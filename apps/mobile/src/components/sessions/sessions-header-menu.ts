import { SESSION_SORT_KEYS, type SessionListQuery } from "@clawdi/shared/api";
import type { Translator } from "@/lib/i18n";
import type { HeaderMenu, HeaderMenuSection } from "@/platform/navigation/native-header-types";

type SessionSort = (typeof SESSION_SORT_KEYS)[number];

/** Sort, order and (inside an Agent) profile as checked single-choice menu sections. */
export function sessionsHeaderMenu({
	t,
	sort,
	order,
	searchReady,
	profileSection,
	onChange,
}: {
	t: Translator;
	sort: string | null | undefined;
	order: string | null | undefined;
	/** Relevance only ranks search results. */
	searchReady: boolean;
	profileSection: HeaderMenuSection | null;
	onChange: (values: SessionListQuery) => void;
}): HeaderMenu {
	const sorts = SESSION_SORT_KEYS.filter((key) => key !== "relevance" || searchReady);
	return {
		label: t("sessionFilters.options"),
		sections: [
			{
				id: "sort",
				title: t("sessionFilters.sort"),
				items: sorts.map((key: SessionSort) => ({
					id: key,
					label: t(`sessionFilters.${key}`),
					selected: sort === key,
					onPress: () => onChange({ sort: key }),
				})),
			},
			{
				id: "order",
				title: t("sessionFilters.order"),
				items: (["asc", "desc"] as const).map((value) => ({
					id: value,
					label: t(`sessionFilters.${value}`),
					selected: order === value,
					onPress: () => onChange({ order: value }),
				})),
			},
			...(profileSection ? [profileSection] : []),
		],
	};
}
