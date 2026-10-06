import { createContext } from "react";
/** Resolve Web's phone-only descendant target sizes for native Button children. */
export function touchTargetsFor(recipe: string) {
	return {
		button: /max-sm:\[&_button\]:(min-h-\S+)/.exec(recipe)?.[1] ?? "",
		icon: /max-sm:\[&_button\[aria-label\]\]:(min-w-\S+)/.exec(recipe)?.[1] ?? "",
	};
}
export const TouchTargetContext = createContext({ button: "", icon: "" });
