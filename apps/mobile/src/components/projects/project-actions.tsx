import type { Project } from "@clawdi/shared/api";
import { projectActionsClasses } from "@clawdi/shared/ui";
import {
	canManageCustomProject,
	displayProjectName,
	PROJECT_ACTION_COPY,
	projectArchiveTitle,
} from "@clawdi/shared/view";
import { useQueryClient } from "@tanstack/react-query";
import { router } from "expo-router";
import { MoreHorizontal, Pencil } from "lucide-react-native";
import { useRef, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useMobileApi } from "@/components/api-provider";
import { Button } from "@/components/ui/button";
import { ConfirmAction } from "@/components/ui/confirm-action";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import {
	DropdownMenu,
	DropdownMenuContent,
	DropdownMenuItem,
	DropdownMenuSeparator,
	DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Icon } from "@/components/ui/icon";
import { Input, Label } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { WebView, webBoth } from "@/components/ui/web-layout";
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
	const [editOpen, setEditOpen] = useState(false),
		[archiveOpen, setArchiveOpen] = useState(false),
		[name, setName] = useState(project.name),
		[description, setDescription] = useState(project.description ?? "");
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
							accessibilityLabel={`Actions for ${displayProjectName(project)}`}
						>
							<Icon as={MoreHorizontal} />
						</Button>
					}
				/>
				<DropdownMenuContent>
					<DropdownMenuItem
						label={t("libraryPort.edit")}
						onSelect={() => {
							setName(project.name);
							setDescription(project.description ?? "");
							action.clearError();
							setEditOpen(true);
						}}
					/>
					<DropdownMenuItem
						label={PROJECT_ACTION_COPY.share}
						onSelect={() =>
							router.push({
								pathname: "/projects/[projectId]/sharing",
								params: { projectId: project.id },
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
			<Dialog
				open={editOpen}
				onOpenChange={(next) => {
					if (!action.busy) setEditOpen(next);
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{t("libraryPort.editProject")}</DialogTitle>
						<DialogDescription>{PROJECT_ACTION_COPY.editDescription}</DialogDescription>
					</DialogHeader>
					<WebView recipe={projectActionsClasses.form}>
						<WebView recipe={projectActionsClasses.field}>
							<Label>{t("libraryPort.name")}</Label>
							<Input value={name} onChangeText={setName} maxLength={200} editable={!action.busy} />
						</WebView>
						<WebView recipe={projectActionsClasses.field}>
							<Label>{t("libraryPort.description")}</Label>
							<Input
								value={description}
								onChangeText={setDescription}
								maxLength={2000}
								multiline
								editable={!action.busy}
								className={webBoth(projectActionsClasses.textarea)}
							/>
						</WebView>
					</WebView>
					{action.error ? <ApiErrorPanel error={action.error} /> : null}
					<DialogFooter>
						<Button variant="ghost" disabled={action.busy} onPress={() => setEditOpen(false)}>
							<Text>{t("libraryPort.cancel")}</Text>
						</Button>
						<Button
							disabled={action.busy || !name.trim()}
							onPress={() => {
								const visible = capture();
								void action.run(async (current) => {
									await check();
									if (!current() || !visible()) return;
									await read((s) =>
										cloud.updateProject(
											project.id,
											{ name: name.trim(), description: description.trim() || null },
											s,
										),
									);
									if (!current()) return;
									await refresh();
									if (current() && visible()) setEditOpen(false);
								});
							}}
						>
							<Icon as={Pencil} />
							<Text>{t("libraryPort.save")}</Text>
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
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
