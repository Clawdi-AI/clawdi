import { Link } from "@tanstack/react-router";
import { ArrowLeft } from "lucide-react";
import { Button } from "@/components/ui/button";
import type { ResourceReturnTarget } from "@/lib/resource-navigation";

export function ResourceContextBackLink({ target }: { target: ResourceReturnTarget | null }) {
	if (!target) return null;
	return (
		<Button
			render={<Link to={target.href} />}
			nativeButton={false}
			variant="ghost"
			size="sm"
			className="w-fit"
		>
			<ArrowLeft className="size-4" />
			{target.label}
		</Button>
	);
}
