import { createProjectDialogClasses as styles } from "@clawdi/shared/ui";
import { createProjectDialogCopy as copy } from "@clawdi/shared/view";
import { useQueryClient } from "@tanstack/react-query";
import { Plus } from "lucide-react-native";
import { useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useMobileApi } from "@/components/api-provider";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Icon } from "@/components/ui/icon";
import { Input, Label } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { WebView, webView } from "@/components/ui/web-layout";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";

export function AgentCreateProjectDialog({
	agentId,
	disabled,
}: {
	agentId: string;
	disabled?: boolean;
}) {
	const scope = useAccountScope(),
		read = useAccountRead(),
		action = useAuthAction(scope);
	const { agentProjects } = useMobileApi();
	const cache = useQueryClient();
	const [open, setOpen] = useState(false),
		[name, setName] = useState(""),
		[description, setDescription] = useState("");
	const close = () => {
		setOpen(false);
		setName("");
		setDescription("");
		action.clearError();
	};
	const submit = () =>
		action.run(async (isCurrent) => {
			if (disabled || !name.trim() || !scope.isReady) return;
			await read((signal) =>
				agentProjects.createProject(
					agentId,
					{ name: name.trim(), description: description.trim() || null },
					signal,
				),
			);
			if (!isCurrent()) return;
			close();
			await cache.invalidateQueries({ queryKey: accountQueryKey(scope) });
		});
	return (
		<>
			<Button size="sm" disabled={disabled || action.busy} onPress={() => setOpen(true)}>
				<Icon as={Plus} />
				<Text>{copy.title}</Text>
			</Button>
			<Dialog
				open={open}
				onOpenChange={(next) => {
					if (!action.busy) {
						if (next) setOpen(true);
						else close();
					}
				}}
			>
				<DialogContent className={webView(styles.dialog)}>
					<DialogHeader>
						<DialogTitle>{copy.title}</DialogTitle>
						<DialogDescription>{copy.agentDescription}</DialogDescription>
					</DialogHeader>
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
						<DialogFooter>
							<Button variant="ghost" disabled={action.busy} onPress={close}>
								<Text>{copy.cancel}</Text>
							</Button>
							<Button
								disabled={!name.trim() || action.busy || disabled}
								onPress={() => void submit()}
							>
								<Icon as={Plus} />
								<Text>{copy.title}</Text>
							</Button>
						</DialogFooter>
					</WebView>
				</DialogContent>
			</Dialog>
		</>
	);
}
