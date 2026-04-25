import { ArrowLeft } from "lucide-react";
import Link from "next/link";
import { Button } from "@/components/ui/button";

/**
 * Detail page top bar — a back link on the left, optional action slot on the
 * right. Used by Sessions / Memories / Agents / Skills detail pages so the
 * back affordance, spacing, and alignment stay identical across the app.
 */
export function DetailHeader({
	backHref,
	backLabel,
	actions,
}: {
	backHref: string;
	backLabel: string;
	actions?: React.ReactNode;
}) {
	return (
		<div className="flex items-center justify-between gap-3">
			<Button asChild variant="ghost" size="sm" className="-ml-2 text-muted-foreground">
				<Link href={backHref}>
					<ArrowLeft />
					{backLabel}
				</Link>
			</Button>
			{actions ? <div className="flex items-center gap-2">{actions}</div> : null}
		</div>
	);
}
