import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { ProjectsSurface } from "@/components/projects/projects-surface";
import { cn } from "@/lib/utils";

export default function ProjectsPage() {
	return (
		<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "px-4 lg:px-6")}>
			<ProjectsSurface />
		</div>
	);
}
