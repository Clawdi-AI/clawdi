import type { Project } from "@clawdi/shared/api";
import {
	canManageCustomProject,
	displayProjectName,
	PROJECT_ACTION_COPY,
	projectArchiveTitle,
} from "@clawdi/shared/view";
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import MoreHorizontal from "lucide-react-native/icons/ellipsis";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { useForegroundLease } from "@/platform/use-foreground-lease";

export function ProjectCardActions({ project }: { project: Project }) {
	const t = useI18n(),
		scope = useAccountScope(),
		read = useAccountRead(),
		capture = useForegroundLease();
	const { cloud } = useMobileApi(),
		action = useAuthAction(scope),
		cache = useQueryClient();
	const [archiveOpen, setArchiveOpen] = useState(false);
	const confirmationLease = useRef<() => boolean>(() => false);
	const check = async () => {
		const fresh = (await read((s) => cloud.listProjects(s))).find((p) => p.id === project.id);
		if (!fresh || !canManageCustomProject(fresh)) throw new Error("Project unavailable");
	};
	const refresh = () => cache.invalidateQueries({ queryKey: accountQueryKey(scope) });
	if (!canManageCustomProject(project)) return null;
	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					disabled={action.busy}
					render={
						<Button
							size="icon-sm"
							variant="ghost"
							accessibilityLabel={t("labels.actionsFor", { name: displayProjectName(project) })}
						>
							<Icon as={MoreHorizontal} />
						</Button>
					}
				/>
				<DropdownMenuContent>
					<DropdownMenuItem
						label={t("libraryPort.edit")}
						onSelect={() => {
							router.push({ pathname: "/projects/[id]/edit", params: { id: project.id } });
						}}
					/>
					<DropdownMenuItem
						label={PROJECT_ACTION_COPY.share}
						onSelect={() =>
							router.push({
								pathname: "/projects/[id]/sharing",
								params: { id: project.id },
							})
						}
					/>
					<DropdownMenuSeparator />
					<DropdownMenuItem
						label={PROJECT_ACTION_COPY.archive}
						variant="destructive"
						onSelect={() => {
							confirmationLease.current = capture();
							setArchiveOpen(true);
						}}
					/>
				</DropdownMenuContent>
			</DropdownMenu>
			<ConfirmAction
				open={archiveOpen}
				onOpenChange={setArchiveOpen}
				title={projectArchiveTitle(displayProjectName(project))}
				description={PROJECT_ACTION_COPY.archiveDescription}
				confirmLabel={PROJECT_ACTION_COPY.archiveConfirm}
				destructive
				onConfirm={async () => {
					await check();
					if (!confirmationLease.current() || !scope.isCurrent())
						throw new Error("Project unavailable");
					await read((s) => cloud.archiveProject(project.id, s));
					if (scope.isCurrent()) await refresh();
				}}
			/>
		</>
	);
}
