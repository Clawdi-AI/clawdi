import { cn } from "cn";
import { useState } from "react";
import { Image } from "react-native";
import { withUniwind } from "uniwind";
import { Text } from "./text";
import { AppView } from "./view";

const AppImage = withUniwind(Image);
const sizes = { sm: "size-6", default: "size-8", lg: "size-10" } as const;

/** Mirrors apps/web/src/components/ui/avatar.tsx: image with initials fallback. */
export function Avatar({
	src,
	fallback,
	size = "default",
	className,
}: {
	src?: string | null;
	fallback: string;
	size?: keyof typeof sizes;
	className?: string;
}) {
	const [failed, setFailed] = useState(false);
	return (
		<AppView
			className={cn(
				"shrink-0 overflow-hidden rounded-full border border-border",
				sizes[size],
				className,
			)}
		>
			{src && !failed ? (
				<AppImage
					source={{ uri: src }}
					onError={() => setFailed(true)}
					className="size-full rounded-full"
					accessibilityIgnoresInvertColors
				/>
			) : (
				<AppView className="size-full items-center justify-center rounded-full bg-muted">
					<Text className={cn("text-muted-foreground", size === "sm" ? "text-xs" : "text-sm")}>
						{fallback}
					</Text>
				</AppView>
			)}
		</AppView>
	);
}
