import { createProjectDialogClasses as styles } from "@clawdi/shared/ui";
import { createProjectDialogCopy as copy } from "@clawdi/shared/view";
import { useQueryClient } from "@tanstack/react-query";
import { useLocalSearchParams } from "expo-router";
import Plus from "lucide-react-native/icons/plus";
import { useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input, Label } from "@/components/ui/input";
import { SheetPage } from "@/components/ui/sheet-page";
import { Text } from "@/components/ui/text";
import { WebView, webView } from "@/components/ui/web-layout";
import { useMobileApi } from "@/lib/api-provider";
import { routeParam } from "@/lib/route-params";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { useSheet } from "@/platform/navigation/use-sheet";

export function AgentCreateProjectScreen() {
	const params = useLocalSearchParams<{ id?: string | string[] }>();
	const agentId = routeParam(params.id);
	const scope = useAccountScope(),
		read = useAccountRead(),
		action = useAuthAction(scope);
	const { agentProjects, cloud } = useMobileApi();
	const cache = useQueryClient();
	const [name, setName] = useState(""),
		[description, setDescription] = useState("");
	const sheet = useSheet<boolean>({
		fallback: agentId ? `/agents/${agentId}/project-access` : "/agents",
		busy: action.busy,
		onResult: () => cache.invalidateQueries({ queryKey: accountQueryKey(scope) }),
	});
	const submit = () =>
		action.run(async (isCurrent) => {
			if (!agentId || !name.trim() || !scope.isReady) return;
			await read(async (signal) => {
				const agent = await cloud.getAgent(agentId, signal);
				if (agent.id !== agentId) throw new Error("Agent identity changed");
				await agentProjects.listBindings(agentId, signal);
				return agentProjects.createProject(
					agentId,
					{ name: name.trim(), description: description.trim() || null },
					signal,
				);
			});
			if (!isCurrent()) return;
			await sheet.close(true);
		});
	return (
		<SheetPage
			title={copy.title}
			description={copy.agentDescription}
			fallback={agentId ? `/agents/${agentId}/project-access` : "/agents"}
			busy={action.busy}
			sheet={sheet}
		>
			<WebView recipe={styles.form}>
				<WebView recipe={styles.field}>
					<Label>{copy.name}</Label>
					<Input
						value={name}
						onChangeText={setName}
						maxLength={200}
						editable={!action.busy}
						placeholder={copy.namePlaceholder}
					/>
				</WebView>
				<WebView recipe={styles.field}>
					<Label>{copy.descriptionLabel}</Label>
					<Input
						multiline
						className={webView(styles.description)}
						value={description}
						onChangeText={setDescription}
						maxLength={2000}
						editable={!action.busy}
						placeholder={copy.descriptionPlaceholder}
					/>
				</WebView>
				{action.error ? <ApiErrorPanel title={copy.error} error={action.error} /> : null}
				<WebView recipe={styles.form} className="flex-row justify-end gap-2">
					<Button disabled={!name.trim() || action.busy || !agentId} onPress={() => void submit()}>
						<Icon as={Plus} />
						<Text>{copy.title}</Text>
					</Button>
				</WebView>
			</WebView>
		</SheetPage>
	);
}
