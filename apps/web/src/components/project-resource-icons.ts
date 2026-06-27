import type { LucideIcon } from "lucide-react";
import { Brain, FolderKanban, Key, MessageSquare, Plug, Sparkles } from "lucide-react";
import type { ProjectResourceId } from "@/lib/project-resource-model";

export const PROJECT_RESOURCE_ICONS = {
	projects: FolderKanban,
	skills: Sparkles,
	vaults: Key,
	sessions: MessageSquare,
	memories: Brain,
	connectors: Plug,
} satisfies Record<ProjectResourceId, LucideIcon>;
