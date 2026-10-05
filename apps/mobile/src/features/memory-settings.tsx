import { memoriesSurfaceClasses } from "@clawdi/shared/ui";
import { memoryFormCopy as copy } from "@clawdi/shared/view";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Brain, Database } from "lucide-react-native";
import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { useAuthAction } from "../auth/use-auth-action";
import { useI18n } from "../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useMobileApi } from "../providers/api-provider";
import { Button } from "../ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../ui/dialog";
import { ErrorState } from "../ui/feedback";
import { Icon } from "../ui/icon";
import { Input, Label } from "../ui/input";
import { Skeleton } from "../ui/skeleton";
import { Text } from "../ui/text";
import { ToggleGroup, ToggleGroupItem } from "../ui/toggle-group";
import { webView } from "../ui/web-layout";

export function MemorySettings() {
	const scope = useAccountScope();
	return <MemorySettingsView key={`${scope.accountKey}:${scope.generation}`} />;
}

function MemorySettingsView() {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { account } = useMobileApi();
	const cache = useQueryClient();
	const action = useAuthAction(scope);
	const [open, setOpen] = useState(false);
	const [secret, setSecret] = useState("");

	useEffect(() => {
		const listener = AppState.addEventListener("change", (state) => {
			if (state !== "active") setSecret("");
		});
		return () => listener.remove();
	}, []);
	const settings = useQuery({
		queryKey: accountQueryKey(scope, "memory-settings"),
		queryFn: ({ signal }) =>
			read(async (requestSignal) => {
				const result = await account.getSettings(requestSignal);
				return {
					provider: result.memory_provider === "mem0" ? ("mem0" as const) : ("builtin" as const),
					configured: result.mem0_api_key_configured === true,
				};
			}, signal),
		enabled: scope.isReady,
		retry: false,
	});
	const save = (provider?: "builtin" | "mem0") =>
		action.run(async (isCurrent) => {
			if (!settings.data) return;
			const memoryProvider = provider ?? settings.data.provider;
			const key = secret.trim();
			if (key === "••••••••") return;
			await read((signal) =>
				account.updateSettings(
					{
						settings: {
							memory_provider: memoryProvider,
							...(key ? { mem0_api_key: key } : {}),
						},
					},
					signal,
				),
			);
			if (!isCurrent()) return;
			setSecret("");
			setOpen(false);

			await cache.invalidateQueries({ queryKey: accountQueryKey(scope, "memory-settings") });
			await cache.invalidateQueries({ queryKey: accountQueryKey(scope, "cloud-memories") });
		});
	if (settings.isPending)
		return <Skeleton className={webView(memoriesSurfaceClasses.providerSkeleton)} />;
	if (settings.isError) return <ErrorState onRetry={() => void settings.refetch()} />;
	return (
		<>
			<ToggleGroup
				value={[settings.data.provider]}
				variant="outline"
				size="sm"
				disabled={action.busy}
				onValueChange={(v) => {
					const p = v[0];
					if (p === "builtin" || p === "mem0") void save(p);
				}}
			>
				<ToggleGroupItem value="builtin">
					<Icon as={Database} />
					<Text>{t("memories.builtin")}</Text>
				</ToggleGroupItem>
				<ToggleGroupItem value="mem0">
					<Icon as={Brain} />
					<Text>Mem0</Text>
				</ToggleGroupItem>
			</ToggleGroup>
			{settings.data.provider === "mem0" && !settings.data.configured ? (
				<Button variant="outline" size="sm" onPress={() => setOpen(true)}>
					<Text>{t("memories.mem0Key")}</Text>
				</Button>
			) : null}
			<Dialog
				open={open}
				onOpenChange={(next) => {
					if (!action.busy) {
						setOpen(next);
						if (!next) setSecret("");
					}
				}}
			>
				<DialogContent>
					<DialogHeader>
						<DialogTitle>{copy.mem0Title}</DialogTitle>
						<DialogDescription>{copy.mem0Description}</DialogDescription>
					</DialogHeader>
					<Label>{copy.mem0Label}</Label>
					<Input
						accessibilityLabel={copy.mem0Label}
						placeholder={copy.mem0Placeholder}
						secureTextEntry
						autoCapitalize="none"
						autoCorrect={false}
						value={secret}
						onChangeText={setSecret}
						editable={!action.busy}
					/>
					{action.error ? <ErrorState /> : null}
					<DialogFooter>
						<Button
							variant="ghost"
							disabled={action.busy}
							onPress={() => {
								setOpen(false);
								setSecret("");
							}}
						>
							<Text>{copy.cancel}</Text>
						</Button>
						<Button disabled={action.busy || !secret.trim()} onPress={() => void save()}>
							<Text>{copy.mem0Save}</Text>
						</Button>
					</DialogFooter>
				</DialogContent>
			</Dialog>
		</>
	);
}
