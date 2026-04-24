"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";

const SIZES = {
	sm: { box: "size-9", pad: "p-1", text: "text-sm", radius: "rounded-lg" },
	md: { box: "size-10", pad: "p-1.5", text: "text-base", radius: "rounded-lg" },
	lg: { box: "size-14", pad: "p-2", text: "text-2xl", radius: "rounded-xl" },
} as const;

export function ConnectorIcon({
	logo,
	name,
	size = "md",
}: {
	logo?: string;
	name: string;
	size?: keyof typeof SIZES;
}) {
	const [imgError, setImgError] = useState(false);
	const s = SIZES[size];
	const letter =
		name
			.replace(/^[_\-\s]+/, "")
			.charAt(0)
			.toUpperCase() || "?";

	// Logo: bordered white tile with logo filling via object-contain + small
	// breathing padding. Lets brand colors stay themselves instead of fighting
	// a gray muted backdrop.
	if (logo && !imgError) {
		return (
			<div
				className={cn(
					"flex shrink-0 items-center justify-center overflow-hidden border bg-background",
					s.box,
					s.radius,
				)}
			>
				<img
					src={logo}
					alt=""
					className={cn("h-full w-full object-contain", s.pad)}
					onError={() => setImgError(true)}
				/>
			</div>
		);
	}

	// Fallback: muted initial tile.
	return (
		<div
			className={cn("flex shrink-0 items-center justify-center border bg-muted", s.box, s.radius)}
		>
			<span className={cn("font-semibold text-muted-foreground", s.text)}>{letter}</span>
		</div>
	);
}
