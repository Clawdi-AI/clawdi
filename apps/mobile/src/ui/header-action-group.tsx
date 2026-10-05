import { headerActionGroupClasses } from "@clawdi/shared/ui";
import type { ReactNode } from "react";
import { TouchTargetContext, touchTargetsFor } from "./touch-target";
import { WebView } from "./web-layout";
export function HeaderActionGroup({
	children,
	className,
}: {
	children: ReactNode;
	className?: string;
}) {
	return (
		<TouchTargetContext.Provider value={touchTargetsFor(headerActionGroupClasses.root)}>
			<WebView recipe={headerActionGroupClasses.root} className={className}>
				{children}
			</WebView>
		</TouchTargetContext.Provider>
	);
}
