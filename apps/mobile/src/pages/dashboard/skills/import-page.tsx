import {
	isWritableSkillProject,
	type Project,
	parseProjectSkillGitHubInput,
} from "@clawdi/shared/api";
import { dialogClasses } from "@clawdi/shared/ui";
import {
	importSkillDescription,
	isProjectOwner,
	LIBRARY_COPY,
	SKILLS_LIST_COPY,
} from "@clawdi/shared/view";
import { useQueryClient } from "@tanstack/react-query";
import Import from "lucide-react-native/icons/import";
import { useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { ProjectResourceBoundary } from "@/components/projects/project-scope";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input, Label } from "@/components/ui/input";
import { SheetPage } from "@/components/ui/sheet-page";
import { Text } from "@/components/ui/text";
import { WebView } from "@/components/ui/web-layout";
import { useMobileApi } from "@/lib/api-provider";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { useSheet } from "@/platform/navigation/use-sheet";
import { useForegroundLease } from "@/platform/use-foreground-lease";

/** Web's Import from GitHub dialog for one owned project. */
export default function ImportSkillPage() {
	return (
		<ProjectResourceBoundary>
			{(project) => (project ? <ImportSkill project={project} /> : null)}
		</ProjectResourceBoundary>
	);
}

function ImportSkill({ project }: { project: Project }) {
	const scope = useAccountScope();
	const read = useAccountRead();
	const capture = useForegroundLease();
	const { skills, cloud } = useMobileApi();
	const action = useAuthAction(scope.identity);
	const sheet = useSheet<boolean>({ fallback: "/skills", busy: action.busy });
	const cache = useQueryClient();
	const [source, setSource] = useState("");
	const disabled = !source.trim() || action.busy;
	const submit = () =>
		action.run(async (current) => {
			if (disabled) return;
			const visible = capture();
			const fresh = (await read((s) => cloud.listProjects(s))).find((p) => p.id === project.id);
			if (!fresh || fresh.archived_at || !isWritableSkillProject(fresh) || !isProjectOwner(fresh))
				throw new Error("This project is read-only");
			if (!current() || !visible()) return;
			await read((s) => skills.install(project.id, parseProjectSkillGitHubInput(source), s));
			if (!current()) return;
			await cache.invalidateQueries({ queryKey: accountQueryKey(scope) });
			if (current() && visible()) await sheet.close(true);
		});
	return (
		<SheetPage
			title={LIBRARY_COPY.importSkill}
			description={importSkillDescription(project)}
			fallback="/skills"
			busy={action.busy}
			sheet={sheet}
		>
			<WebView recipe="gap-1.5">
				<Label>{SKILLS_LIST_COPY.importLabel}</Label>
				<Input
					accessibilityLabel={SKILLS_LIST_COPY.importLabel}
					placeholder={SKILLS_LIST_COPY.importPlaceholder}
					autoCapitalize="none"
					autoCorrect={false}
					autoFocus
					editable={!action.busy}
					value={source}
					onChangeText={setSource}
					onSubmitEditing={() => void submit()}
				/>
			</WebView>
			{action.error ? (
				<ApiErrorPanel error={action.failure} title={SKILLS_LIST_COPY.importFailed} />
			) : null}
			<WebView recipe={dialogClasses.footer}>
				<Button disabled={disabled} onPress={() => void submit()}>
					<Icon as={Import} />
					<Text>{action.busy ? SKILLS_LIST_COPY.importing : SKILLS_LIST_COPY.importSubmit}</Text>
				</Button>
			</WebView>
		</SheetPage>
	);
}
