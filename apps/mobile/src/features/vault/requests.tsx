import { buildVaultSecretRequest, type components, safeVaultRequestUrl } from "@clawdi/shared/api";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useFocusEffect } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Alert, AppState, Share } from "react-native";
import { useAuthAction } from "../../auth/use-auth-action";
import { useI18n } from "../../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../../platform/account-lifecycle";
import { useForegroundLease } from "../../platform/use-foreground-lease";
import { useMobileApi } from "../../providers/api-provider";
import { NativeButton, NativePicker } from "../../ui/native-controls";
import { AppText, AppTextInput, AppView } from "../../ui/primitives";
import { useCloudProjects } from "../projects";
import { ResourceError } from "../resource-error";

export function VaultRequests({ current }: { current: components["schemas"]["VaultResponse"] }) {
	const t = useI18n();
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
		Alert.alert(t("vault.requestCreate"), t("vault.requestWarning"), [
			{ text: t("account.cancel"), style: "cancel" },
			{
				text: t("vault.requestCreate"),
				onPress: () => {
					if (!visible() || signal.aborted || !scope.isCurrent()) return;
					void action.run(async (isCurrent) => {
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
		<AppView className="gap-3 rounded-xl bg-surface p-4">
			<AppText accessibilityRole="header" className="text-lg font-semibold text-foreground">
				{t("vault.requests")}
			</AppText>
			<AppText className="text-muted">{t("vault.requestsDescription")}</AppText>
			{canReshare ? (
				<NativeButton
					label={t("vault.requestReshare")}
					disabled={action.busy}
					onPress={() => {
						const visible = capture();
						void action.run(async () => {
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
				/>
			) : null}
			<NativeButton
				label={t("vault.refresh")}
				disabled={requests.isFetching || action.busy}
				onPress={() => {
					started.current = Date.now();
					void requests.refetch();
				}}
			/>
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
					<AppText className="text-muted">
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
			<NativePicker
				value={projectId}
				onValueChange={setProjectId}
				disabled={action.busy || projects.isError}
				options={[
					{ value: "", label: t("vault.attachTarget") },
					...attached.map((p) => ({ value: p.id, label: p.name })),
				]}
			/>
			<AppTextInput
				accessibilityLabel={t("vault.section")}
				placeholder={t("vault.section")}
				value={section}
				onChangeText={setSection}
				maxLength={200}
				editable={!action.busy}
				autoCapitalize="none"
				autoCorrect={false}
				className="rounded-xl bg-background p-3 text-foreground"
			/>
			<AppTextInput
				accessibilityLabel={t("vault.requestFields")}
				placeholder={t("vault.requestFields")}
				value={fields}
				onChangeText={setFields}
				multiline
				maxLength={6500}
				editable={!action.busy}
				autoCapitalize="none"
				autoCorrect={false}
				className="rounded-xl bg-background p-3 text-foreground"
			/>
			<NativePicker
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
			<NativeButton
				label={t("vault.requestCreate")}
				onPress={create}
				disabled={!body || action.busy || projects.isError || projects.isFetching}
			/>
			{action.error ? <AppText accessibilityRole="alert">{t("vault.failed")}</AppText> : null}
		</AppView>
	);
}
