import { skillTransferTargets, transferSkill } from "@clawdi/shared/api";
import { dialogClasses, sendSkillDialogClasses } from "@clawdi/shared/ui";
import {
	skillFormCopy as copy,
	displayProjectName,
	LIBRARY_COPY,
	sendSkillResult,
	sendSkillTitle,
} from "@clawdi/shared/view";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import ArrowRight from "lucide-react-native/icons/arrow-right";
import Copy from "lucide-react-native/icons/copy";
import { useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { ChoiceSelect } from "@/components/detail/choice-select";
import { useCloudProjects } from "@/components/projects/projects-surface";
import { Alert } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Label } from "@/components/ui/input";
import { SheetPage } from "@/components/ui/sheet-page";
import { Text } from "@/components/ui/text";
import { WebText, WebView, webView } from "@/components/ui/web-layout";
import { useMobileApi } from "@/lib/api-provider";
import { routeParam } from "@/lib/route-params";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { useSheet } from "@/platform/navigation/use-sheet";
import { useForegroundLease } from "@/platform/use-foreground-lease";

/** Web's Send skill dialog: copy or move one Cloud skill to another owned project. */
export function SendSkillScreen() {
	const params = useLocalSearchParams<{ projectId?: string | string[]; key?: string | string[] }>();
	const scope = useAccountScope();
	const projectId = routeParam(params.projectId) ?? "";
	const skillKey = routeParam(params.key) ?? "";
	return (
		<SendSkill
			key={`${scope.accountKey}:${scope.generation}:${projectId}:${skillKey}`}
			projectId={projectId}
			skillKey={skillKey}
		/>
	);
}

function SendSkill({ projectId, skillKey }: { projectId: string; skillKey: string }) {
	const scope = useAccountScope();
	const read = useAccountRead();
	const capture = useForegroundLease();
	const { skills, cloud } = useMobileApi();
	const action = useAuthAction(scope.identity);
	const sheet = useSheet<boolean>({ fallback: "/skills", busy: action.busy });
	const cache = useQueryClient();
	const projects = useCloudProjects();
	const [targetId, setTargetId] = useState("");
	const [partial, setPartial] = useState<string | null>(null);
	const detail = useQuery({
		queryKey: accountQueryKey(scope, "skill-detail", projectId, skillKey),
		enabled: scope.isReady && Boolean(projectId && skillKey),
		retry: false,
		queryFn: ({ signal }) => read((lease) => skills.get(projectId, skillKey, lease), signal),
	});
	const targets = skillTransferTargets(projects.data ?? [], projectId);
	const target = targets.find((p) => p.id === targetId);
	const disabled = !target || action.busy || projects.isError || detail.isPending || detail.isError;
	const send = (move: boolean) =>
		action.run(async (current) => {
			if (disabled) return;
			setPartial(null);
			const visible = capture();
			const [freshProjects, freshSkill] = await Promise.all([
				read((signal) => cloud.listProjects(signal)),
				read((signal) => skills.get(projectId, skillKey, signal)),
			]);
			const source = freshProjects.find((p) => p.id === projectId);
			const destination = freshProjects.find((p) => p.id === targetId);
			if (!source || !destination || freshSkill.skill_key !== skillKey)
				throw new Error("Skill unavailable");
			if (!current() || !visible()) return;
			const { sourceRemoved } = await read((signal) =>
				transferSkill({
					skill: freshSkill,
					source,
					target: destination,
					move,
					download: () => skills.download(projectId, skillKey, signal),
					upload: (archive) => skills.upload(targetId, skillKey, archive, true, signal),
					remove: (revision) => skills.remove(projectId, skillKey, revision, signal),
				}),
			);
			if (!current()) return;
			await cache.invalidateQueries({ queryKey: accountQueryKey(scope) });
			// A move that kept its source stays open so the notice remains visible.
			if (sourceRemoved === false)
				setPartial(
					sendSkillResult(false, freshSkill.name, displayProjectName(destination)).description,
				);
			else if (current() && visible()) await sheet.close(true);
		});
	return (
		<SheetPage
			title={sendSkillTitle(detail.data?.name ?? skillKey)}
			fallback="/skills"
			busy={action.busy}
			sheet={sheet}
		>
			<WebView recipe="text-sm text-muted-foreground">
				<Text>
					{copy.transferDescription} {copy.transferAlternativeBefore}
					<WebText recipe={sendSkillDialogClasses.emphasis}>
						{copy.transferAlternativeEmphasis}
					</WebText>
					{copy.transferAlternativeAfter}
				</Text>
			</WebView>
			<WebView recipe={sendSkillDialogClasses.body}>
				<WebView recipe={sendSkillDialogClasses.field}>
					<Label>{copy.destination}</Label>
					<ChoiceSelect
						triggerClassName={webView(sendSkillDialogClasses.trigger)}
						value={targetId}
						onValueChange={setTargetId}
						disabled={action.busy}
						options={[
							{ value: "", label: copy.chooseProject },
							...targets.map((p) => ({ value: p.id, label: displayProjectName(p) })),
						]}
					/>
				</WebView>
				{projects.isError ? (
					<ApiErrorPanel
						error={projects.error}
						onRetry={() => void projects.refetch()}
						title={LIBRARY_COPY.loadDestinationsFailed}
					/>
				) : null}
				{detail.isError ? (
					<ApiErrorPanel error={detail.error} onRetry={() => void detail.refetch()} />
				) : null}
				{partial ? (
					<Alert title={sendSkillResult(false, "").title}>{partial}</Alert>
				) : action.error ? (
					<ApiErrorPanel error={action.failure} title={copy.sendFailed} />
				) : null}
				<WebView recipe={dialogClasses.footer}>
					<Button variant="outline" disabled={disabled} onPress={() => void send(false)}>
						<Icon as={Copy} />
						<Text>{copy.copy}</Text>
					</Button>
					<Button disabled={disabled} onPress={() => void send(true)}>
						<Icon as={ArrowRight} />
						<Text>{copy.move}</Text>
					</Button>
				</WebView>
			</WebView>
		</SheetPage>
	);
}
