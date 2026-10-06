import { headerActionGroupClasses } from "@clawdi/shared/ui";
import type { ReactNode } from "react";
import { WebView } from "@/components/ui/web-layout";
import { TouchTargetContext, touchTargetsFor } from "@/platform/touch-target";
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
