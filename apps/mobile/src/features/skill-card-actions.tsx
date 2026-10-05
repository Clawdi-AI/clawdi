import {
	type components,
	type Project,
	skillCapabilities,
	skillTransferTargets,
	transferSkill,
} from "@clawdi/shared/api";
import { skillTransferDialogClasses } from "@clawdi/shared/ui";
import {
	displayProjectName,
	LIBRARY_COPY,
	SKILL_TRANSFER_COPY,
	skillRemovalDescription,
	skillRemovalTitle,
	skillTransferTitle,
} from "@clawdi/shared/view";
import { useQueryClient } from "@tanstack/react-query";
import { ArrowRight, Copy, MoreHorizontal } from "lucide-react-native";
import { useRef, useState } from "react";
import { useAuthAction } from "../auth/use-auth-action";
import { useI18n } from "../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useForegroundLease } from "../platform/use-foreground-lease";
import { useMobileApi } from "../providers/api-provider";
import { ApiErrorPanel } from "../ui/api-error-panel";
import { Button } from "../ui/button";
import { ConfirmAction } from "../ui/confirm-action";
import { ChoiceSelect } from "../ui/detail/choice-select";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuTrigger,
} from "../ui/dropdown-menu";
import { Icon } from "../ui/icon";
import { Label } from "../ui/input";
import { Text } from "../ui/text";
import { WebView } from "../ui/web-layout";
import { useCloudProjects } from "./projects";

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
	const projects = useCloudProjects();
	const [open, setOpen] = useState(false),
		[removeOpen, setRemoveOpen] = useState(false),
		[targetId, setTargetId] = useState(""),
		[partial, setPartial] = useState(false);
	const confirmationLease = useRef<() => boolean>(() => false);
	const capabilities = skillCapabilities(skill, project);
	const targets = skillTransferTargets(projects.data ?? [], project.id);
	const changed = () => cache.invalidateQueries({ queryKey: accountQueryKey(scope) });
	const send = (move: boolean) => {
		const visible = capture();
		void action.run(async (current) => {
			if (!capabilities.canSend || project.archived_at || !targetId || !visible()) return;
			const [freshProjects, freshSkill] = await Promise.all([
				read((s) => cloud.listProjects(s)),
				read((s) => skills.get(project.id, skill.skill_key, s)),
			]);
			const source = freshProjects.find((p) => p.id === project.id),
				target = freshProjects.find((p) => p.id === targetId);
			if (
				!source ||
				!target ||
				freshSkill.project_id !== project.id ||
				freshSkill.skill_key !== skill.skill_key
			)
				throw new Error("Skill unavailable");
			if (!current() || !visible()) return;
			const result = await read((signal) =>
				transferSkill({
					skill: freshSkill,
					source,
					target,
					move,
					download: () => skills.download(source.id, skill.skill_key, signal),
					upload: (archive) => skills.upload(target.id, skill.skill_key, archive, true, signal),
					remove: (revision) => skills.remove(source.id, skill.skill_key, revision, signal),
				}),
			);
			if (!current()) return;
			await changed();
			if (current() && visible()) {
				setPartial(result.sourceRemoved === false);
				if (result.sourceRemoved !== false) setOpen(false);
			}
		});
	};
	if ((!capabilities.canSend && !capabilities.canDelete) || project.archived_at) return null;
	return (
		<>
			<DropdownMenu>
				<DropdownMenuTrigger
					disabled={action.busy}
					render={
						<Button variant="ghost" size="icon-sm" accessibilityLabel={`Actions for ${skill.name}`}>
							<Icon as={MoreHorizontal} />
						</Button>
					}
				/>
				<DropdownMenuContent>
					{capabilities.canSend ? (
						<DropdownMenuItem
							label={LIBRARY_COPY.copyOrMove}
							onSelect={() => {
								action.clearError();
								setTargetId("");
								setPartial(false);
								setOpen(true);
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
			<Dialog
				open={open}
				onOpenChange={(next) => {
					if (!action.busy) setOpen(next);
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{skillTransferTitle(skill.name)}</DialogTitle>
						<DialogDescription>{SKILL_TRANSFER_COPY.description}</DialogDescription>
					</DialogHeader>
					<WebView recipe={skillTransferDialogClasses.field}>
						<Label>{SKILL_TRANSFER_COPY.destination}</Label>
						<ChoiceSelect
							value={targetId}
							onValueChange={setTargetId}
							disabled={action.busy || partial}
							options={[
								{ value: "", label: SKILL_TRANSFER_COPY.chooseProject },
								...targets.map((p) => ({ value: p.id, label: displayProjectName(p) })),
							]}
						/>
					</WebView>
					{projects.error ? (
						<ApiErrorPanel
							error={projects.error}
							onRetry={() => void projects.refetch()}
							title="Couldn't load destinations"
						/>
					) : null}
					{action.error ? <ApiErrorPanel error={action.error} /> : null}
					{partial ? <Text accessibilityRole="alert">{SKILL_TRANSFER_COPY.partial}</Text> : null}
					<DialogFooter>
						<Button
							variant="outline"
							disabled={
								!targetId || action.busy || projects.isFetching || !!projects.error || partial
							}
							onPress={() => send(false)}
						>
							<Icon as={Copy} />
							<Text>{SKILL_TRANSFER_COPY.copy}</Text>
						</Button>
						<Button
							disabled={
								!targetId || action.busy || projects.isFetching || !!projects.error || partial
							}
							onPress={() => send(true)}
						>
							<Icon as={ArrowRight} />
							<Text>{SKILL_TRANSFER_COPY.move}</Text>
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
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
