import { buildVaultSecretRequest, type components, safeVaultRequestUrl } from "@clawdi/shared/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { AppState, Share } from "react-native";
import { ChoiceSelect } from "@/components/detail/choice-select";
import { useCloudProjects } from "@/components/projects/projects-surface";
import { ResourceError } from "@/components/resource-error";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Text as AppText, Text } from "@/components/ui/text";
import { useConfirmation } from "@/components/ui/use-confirmation";
import { AppView } from "@/components/ui/view";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { useForegroundLease } from "@/platform/use-foreground-lease";

export function VaultRequests({ current }: { current: components["schemas"]["VaultResponse"] }) {
	const t = useI18n();
	const confirmationDialog = useConfirmation();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { vault } = useMobileApi();
	const cache = useQueryClient();
	const capture = useForegroundLease();
	const action = useAuthAction(scope);
	const projects = useCloudProjects();
	const [projectId, setProjectId] = useState("");
	const [section, setSection] = useState("");
	const [fields, setFields] = useState("");
	const [expiry, setExpiry] = useState(3600);
	const [focused, setFocused] = useState(false);
	const [canReshare, setCanReshare] = useState(false);
	const lastLink = useRef<{ url: string; expiresAt: number } | null>(null);
	const started = useRef(Date.now());
	useFocusEffect(
		useCallback(() => {
			started.current = Date.now();
			setFocused(true);
			const clearLink = () => {
				lastLink.current = null;
				setCanReshare(false);
			};
			const listener = AppState.addEventListener("change", (state) => {
				if (state !== "active") clearLink();
			});
			return () => {
				listener.remove();
				clearLink();
				setFocused(false);
			};
		}, []),
	);
	const requests = useQuery({
		queryKey: accountQueryKey(scope, "vault-requests", current.id, current.slug),
		queryFn: async ({ signal }) => {
			const result = await read((s) => vault.listRequests(current, s), signal);
			if (result.some((row) => row.status === "supplied")) {
				void cache.invalidateQueries({
					queryKey: accountQueryKey(scope, "vault-sections", current.id),
				});
			}
			return result;
		},
		enabled: scope.isReady && current.is_owner && focused,
		retry: false,
		refetchInterval: (query) =>
			focused &&
			Date.now() - started.current < 120000 &&
			query.state.data?.some((row) => row.status === "pending")
				? 10000
				: false,
		refetchIntervalInBackground: false,
	});
	const attached = (projects.data ?? []).filter(
		(p) => p.is_owner && !p.archived_at && current.project_ids.includes(p.id),
	);
	const selected = attached.find((p) => p.id === projectId);
	let body: components["schemas"]["VaultSecretRequestCreate"] | undefined;
	try {
		if (selected) body = buildVaultSecretRequest(current, selected.id, section, fields, expiry);
	} catch {
		/* Invalid drafts stay local. */
	}
	const create = () => {
		const visible = capture();
		const request = body;
		const signal = scope.signal;
		if (!request || !visible() || !current.is_owner || projects.isError || action.busy) return;
		confirmationDialog.show(t("vault.requestCreate"), t("vault.requestWarning"), [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: t("vault.requestCreate"),
				onPress: () => {
					if (!visible() || signal.aborted || !scope.isCurrent()) return;
					return action.run(async (isCurrent) => {
						// Keep the capability only in a foreground ref, never persisted or cached.
						const result = await read((s) => vault.createRequest(request, s));
						if (!isCurrent() || !visible()) return;
						const url = safeVaultRequestUrl(result.url);
						const expiresAt = Date.parse(result.expires_at);
						if (!url || !Number.isFinite(expiresAt) || expiresAt <= Date.now())
							throw new Error("Invalid request link");
						lastLink.current = { url, expiresAt };
						setCanReshare(true);
						setFields("");
						await requests.refetch();
						if (!isCurrent() || !visible()) return;
						await Share.share({ title: t("vault.requestShare"), message: url });
					});
				},
			},
		]);
	};
	return (
		<AppView className="gap-3 rounded-xl bg-card p-4">
			<AppText accessibilityRole="header" className="text-lg font-semibold text-foreground">
				{t("vault.requests")}
			</AppText>
			<AppText className="text-muted-foreground">{t("vault.requestsDescription")}</AppText>
			{canReshare ? (
				<Button
					variant="outline"
					size="sm"
					disabled={action.busy}
					onPress={() => {
						const visible = capture();
						return action.run(async () => {
							const link = lastLink.current;
							if (!scope.isCurrent() || !visible()) return;
							if (!link || link.expiresAt <= Date.now()) {
								lastLink.current = null;
								setCanReshare(false);
								return;
							}
							await Share.share({ title: t("vault.requestShare"), message: link.url });
						});
					}}
				>
					<Text>{t("vault.requestReshare")}</Text>
				</Button>
			) : null}
			<Button
				variant="outline"
				size="sm"
				disabled={requests.isFetching || action.busy}
				onPress={() => {
					started.current = Date.now();
					void requests.refetch();
				}}
			>
				<Text>{t("vault.refresh")}</Text>
			</Button>
			{requests.isPending ? <AppText>{t("loading.app")}</AppText> : null}
			{requests.isError ? (
				<ResourceError missing={false} onRetry={() => void requests.refetch()} />
			) : null}
			{projects.isError ? (
				<ResourceError
					missing={false}
					onRetry={projects.isFetching ? undefined : () => void projects.refetch()}
				/>
			) : null}
			{requests.data?.map((row) => (
				<AppView key={row.id} className="gap-1">
					<AppText className="text-foreground">{row.fields.join(", ")}</AppText>
					<AppText className="text-muted-foreground">
						{row.project_name} · {row.section || t("vault.defaultSection")}
					</AppText>
					<AppText>
						{t(
							row.status === "pending"
								? "vault.requestPending"
								: row.status === "supplied"
									? "vault.requestSupplied"
									: row.status === "conflict"
										? "vault.requestConflict"
										: "vault.requestExpired",
						)}{" "}
						· {row.expires_at}
					</AppText>
				</AppView>
			))}
			<ChoiceSelect
				value={projectId}
				onValueChange={setProjectId}
				disabled={action.busy || projects.isError}
				options={[
					{ value: "", label: t("vault.attachTarget") },
					...attached.map((p) => ({ value: p.id, label: p.name })),
				]}
			/>
			<Input
				accessibilityLabel={t("vault.section")}
				placeholder={t("vault.section")}
				value={section}
				onChangeText={setSection}
				maxLength={200}
				editable={!action.busy}
				autoCapitalize="none"
				autoCorrect={false}
			/>
			<Input
				accessibilityLabel={t("vault.requestFields")}
				placeholder={t("vault.requestFields")}
				value={fields}
				onChangeText={setFields}
				multiline
				maxLength={6500}
				editable={!action.busy}
				autoCapitalize="none"
				autoCorrect={false}
			/>
			<ChoiceSelect
				value={expiry}
				onValueChange={setExpiry}
				disabled={action.busy}
				options={[
					{ value: 300, label: t("vault.requestFiveMinutes") },
					{ value: 3600, label: t("vault.requestHour") },
					{ value: 86400, label: t("vault.requestDay") },
				]}
			/>
			{fields && !body ? <AppText>{t("vault.requestInvalid")}</AppText> : null}
			<Button
				variant="outline"
				size="sm"
				onPress={create}
				disabled={!body || action.busy || projects.isError || projects.isFetching}
			>
				<Text>{t("vault.requestCreate")}</Text>
			</Button>
			{action.error ? <AppText accessibilityRole="alert">{t("vault.failed")}</AppText> : null}
			{confirmationDialog.dialog}
		</AppView>
	);
}
