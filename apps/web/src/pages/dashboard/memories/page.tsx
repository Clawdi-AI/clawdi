"use client";

import { detailLayoutClasses } from "@clawdi/shared/ui";

import { getProjectResourceDefinition } from "@clawdi/shared/view";
import { MemoriesPageActions, MemoriesSurface } from "@/components/memories/memories-surface";
import { PageHeader } from "@/components/page-header";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { cn } from "@/lib/utils";

const MEMORIES_RESOURCE = getProjectResourceDefinition("memories");

export default function MemoriesPage() {
	return (
		<div className={cn(CENTERED_PAGE_WIDTH_CLASS.page, detailLayoutClasses.page)}>
			<PageHeader
				title="Memories"
				description={MEMORIES_RESOURCE.managementDescription}
				actions={<MemoriesPageActions />}
			/>
			<MemoriesSurface />
		</div>
	);
}
