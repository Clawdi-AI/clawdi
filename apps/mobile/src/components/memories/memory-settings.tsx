import { memoriesSurfaceClasses } from "@clawdi/shared/ui";
import { memoryFormCopy as copy } from "@clawdi/shared/view";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { Key } from "lucide-react-native";
import { useEffect, useState } from "react";
import { AppState } from "react-native";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { ErrorState } from "@/components/ui/feedback";
import { Icon } from "@/components/ui/icon";
import { Input, Label } from "@/components/ui/input";
import { Skeleton } from "@/components/ui/skeleton";
import { Text } from "@/components/ui/text";
import { WebText, WebView, webBoth, webView } from "@/components/ui/web-layout";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { NativeSegments } from "@/platform/navigation/segmented-control";

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

			await cache.invalidateQueries({ queryKey: accountQueryKey(scope, "memory-settings") });
			await cache.invalidateQueries({ queryKey: accountQueryKey(scope, "cloud-memories") });
		});
	if (settings.isPending)
		return <Skeleton className={webView(memoriesSurfaceClasses.providerSkeleton)} />;
	if (settings.isError) return <ErrorState onRetry={() => void settings.refetch()} />;
	return (
		<>
			<NativeSegments
				value={settings.data.provider}
				disabled={action.busy}
				options={[
					{ value: "builtin", label: t("memories.builtin") },
					{ value: "mem0", label: "Mem0" },
				]}
				onChange={(provider) => {
					if (provider === "builtin" || provider === "mem0") void save(provider);
				}}
			/>
			{action.error ? <ErrorState /> : null}
			{settings.data.provider === "mem0" && !settings.data.configured ? (
				<Card>
					<CardHeader>
						<WebView recipe={memoriesSurfaceClasses.loadingRow}>
							<Icon as={Key} className={webBoth(memoriesSurfaceClasses.loadingIcon)} />
							<CardTitle>{copy.mem0Title}</CardTitle>
						</WebView>
					</CardHeader>
					<CardContent className={webView(memoriesSurfaceClasses.section)}>
						<WebText recipe={memoriesSurfaceClasses.emptyHint}>{copy.mem0Description}</WebText>
						<Label className={webBoth(memoriesSurfaceClasses.keyInput)}>{copy.mem0Label}</Label>
						<WebView recipe={memoriesSurfaceClasses.keyHelp}>
							<Input
								accessibilityLabel={copy.mem0Label}
								placeholder={copy.mem0Placeholder}
								className={webBoth(memoriesSurfaceClasses.fieldStack)}
								secureTextEntry
								autoCapitalize="none"
								autoCorrect={false}
								value={secret}
								onChangeText={setSecret}
								editable={!action.busy}
							/>
							<Button
								className={webView(memoriesSurfaceClasses.inputLabel)}
								disabled={action.busy || !secret.trim()}
								onPress={() => void save()}
							>
								<Icon as={Key} />
								<Text>{copy.mem0Save}</Text>
							</Button>
						</WebView>
					</CardContent>
				</Card>
			) : null}
		</>
	);
}
