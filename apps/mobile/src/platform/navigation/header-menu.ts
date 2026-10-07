import type {
	HeaderAction,
	HeaderMenu,
	HeaderMenuSection,
} from "@/platform/navigation/native-header-types";

export type HeaderMenuGroup =
	| { id: "items"; title?: undefined; items: HeaderAction[] }
	| HeaderMenuSection;

/**
 * Menu groups in display order: untitled root items, then each inline section.
 * Empty groups are dropped. iOS renders titled groups as inline submenus;
 * Android separates consecutive groups with a divider.
 */
export function headerMenuGroups(menu: HeaderMenu): HeaderMenuGroup[] {
	const groups: HeaderMenuGroup[] = [
		{ id: "items", items: menu.items ?? [] },
		...(menu.sections ?? []),
	];
	return groups.filter((group) => group.items.length > 0);
}
