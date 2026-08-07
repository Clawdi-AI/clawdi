"use client";

import { MemoriesPageActions, MemoriesSurface } from "@/components/memories/memories-surface";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { getProjectResourceDefinition } from "@/lib/project-resource-model";
import { cn } from "@/lib/utils";

const MEMORIES_RESOURCE = getProjectResourceDefinition("memories");

export default function MemoriesPage() {
	return (
		<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "space-y-6 px-4 lg:px-6")}>
			<PageHeader
				title="Memories"
				description={MEMORIES_RESOURCE.managementDescription}
				actions={<MemoriesPageActions />}
			/>
			<MemoriesSurface />
		</div>
	);
}
