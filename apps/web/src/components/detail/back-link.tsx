"use client";

import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";

export function DetailBackLink({
	href,
	label,
	mobileOnly = true,
}: {
	href: string;
	label: string;
	mobileOnly?: boolean;
}) {
	return (
		<Button
			render={<Link to={href} />}
			nativeButton={false}
			variant="ghost"
			size="sm"
			className={cn("w-fit", mobileOnly && "sm:hidden")}
		>
			<ArrowLeft className="size-4" />
			Back to {label}
		</Button>
	);
}
