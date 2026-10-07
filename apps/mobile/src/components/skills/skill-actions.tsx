import { type components, type Project, skillCapabilities } from "@clawdi/shared/api";
import { LIBRARY_COPY, skillRemovalDescription, skillRemovalTitle } from "@clawdi/shared/view";
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { MoreHorizontal } from "lucide-react-native";
import { useRef, useState } from "react";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { useForegroundLease } from "@/platform/use-foreground-lease";

type Skill = components["schemas"]["SkillSummaryResponse"];

/** Card-level entry points retain fresh capability/revision checks and safe archive transfer. */
export function SkillCardActions({ skill, project }: { skill: Skill; project: Project }) {
	const t = useI18n(),
		scope = useAccountScope(),
		read = useAccountRead(),
		capture = useForegroundLease();
	const { skills, cloud } = useMobileApi(),
		cache = useQueryClient(),
		action = useAuthAction(scope);
	const [removeOpen, setRemoveOpen] = useState(false);
	const confirmationLease = useRef<() => boolean>(() => false);
	const capabilities = skillCapabilities(skill, project);
	const changed = () => cache.invalidateQueries({ queryKey: accountQueryKey(scope) });
	if ((!capabilities.canSend && !capabilities.canDelete) || project.archived_at) return null;
	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					disabled={action.busy}
					render={
						<Button
							variant="ghost"
							size="icon-sm"
							accessibilityLabel={t("labels.actionsFor", { name: skill.name })}
						>
							<Icon as={MoreHorizontal} />
						</Button>
					}
				/>
				<DropdownMenuContent>
					{capabilities.canSend ? (
						<DropdownMenuItem
							label={LIBRARY_COPY.copyOrMove}
							onSelect={() => {
								router.push({
									pathname: "/skills/[key]/archive",
									params: { key: skill.skill_key, projectId: project.id },
								});
							}}
						/>
					) : null}
					{capabilities.canDelete ? (
						<DropdownMenuItem
							label={LIBRARY_COPY.removeFromProject}
							variant="destructive"
							onSelect={() => {
								confirmationLease.current = capture();
								setRemoveOpen(true);
							}}
						/>
					) : null}
				</DropdownMenuContent>
			</DropdownMenu>
			<ConfirmAction
				open={removeOpen}
				onOpenChange={setRemoveOpen}
				title={skillRemovalTitle(skill.name)}
				description={skillRemovalDescription()}
				confirmLabel={t("libraryPort.removeFromProject")}
				destructive
				onConfirm={async () => {
					if (!confirmationLease.current() || !scope.isCurrent())
						throw new Error("Skill unavailable");
					const [freshProjects, freshSkill] = await Promise.all([
						read((s) => cloud.listProjects(s)),
						read((s) => skills.get(project.id, skill.skill_key, s)),
					]);
					const source = freshProjects.find((p) => p.id === project.id);
					if (
						!source ||
						source.archived_at ||
						!skillCapabilities(freshSkill, source).canDelete ||
						freshSkill.project_id !== project.id ||
						freshSkill.skill_key !== skill.skill_key ||
						!confirmationLease.current() ||
						!scope.isCurrent()
					)
						throw new Error("Skill unavailable");
					await read((s) => skills.remove(project.id, skill.skill_key, skill.content_hash, s));
					if (scope.isCurrent()) await changed();
				}}
			/>
		</>
	);
}
