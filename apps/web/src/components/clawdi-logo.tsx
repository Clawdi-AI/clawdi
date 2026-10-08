import type { ComponentProps } from "react";
import { cn } from "@/lib/utils";

/**
 * The Clawdi mark. The square artwork gets the brand's rounded-square corners
 * (the iOS app icon proportion shared with the favicon and native icons), so the
 * shape stays the same at every size.
 */
export function ClawdiLogo({ alt = "", className, ...props }: Omit<ComponentProps<"img">, "src">) {
	return (
		<img
			src="/clawdi-logo-transparent.png"
			alt={alt}
			className={cn("rounded-[22.37%]", className)}
			{...props}
		/>
	);
}
