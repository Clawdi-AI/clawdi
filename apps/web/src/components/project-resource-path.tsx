import { ChevronRight } from "lucide-react";
import type { ProjectResourceDefinition } from "@/lib/project-resource-model";
import { projectResourcePathLabel } from "@/lib/project-resource-model";
import { cn } from "@/lib/utils";

export function ProjectResourcePath({
	resource,
	className,
}: {
	resource: ProjectResourceDefinition;
	className?: string;
}) {
	return (
		<span
			className={cn(
				"inline-flex min-w-0 max-w-full items-center gap-1 overflow-hidden text-muted-foreground",
				className,
			)}
			title={projectResourcePathLabel(resource)}
		>
			{resource.pathSegments.map((segment, index) => (
				<span key={`${segment}-${index}`} className="inline-flex min-w-0 items-center gap-1">
					<span className="truncate">{segment}</span>
					{index < resource.pathSegments.length - 1 ? (
						<ChevronRight className="size-3 shrink-0" aria-hidden="true" />
					) : null}
				</span>
			))}
		</span>
	);
}
