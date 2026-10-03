import { projectUserSelectableAiProviders } from "@clawdi/shared";
import type { SavedAiProvider } from "@clawdi/shared/api";
import { useQuery } from "@tanstack/react-query";
import { useState } from "react";
import { useAuthAction } from "../auth/use-auth-action";
import { useI18n } from "../i18n";
import { accountQueryKey, useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useMobileApi } from "../providers/api-provider";
import { NativeButton } from "../ui/native-controls";
import { AppText, AppTextInput, AppView } from "../ui/primitives";
import { InventoryList } from "./inventory-list";

export function AiProvidersScreen() {
	const scope = useAccountScope();
	return <ProvidersView key={`${scope.accountKey}:${scope.generation}`} />;
}

function ProvidersView() {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { aiProviders } = useMobileApi();
	const providers = useQuery({
		queryKey: accountQueryKey(scope, "ai-providers"),
		queryFn: ({ signal }) => read((lease) => aiProviders.list(lease), signal),
		enabled: scope.isReady,
		retry: false,
	});
	return (
		<InventoryList
			items={projectUserSelectableAiProviders(providers.data?.providers ?? [])}
			title={t("providers.title")}
			description={t("providers.description")}
			empty={t(providers.isPending ? "loading.app" : "providers.empty")}
			renderItem={(provider) => (
				<ProviderRow
					key={`${provider.id}:${provider.updated_at}`}
					provider={provider}
					refresh={async () => {
						await providers.refetch();
					}}
				/>
			)}
			refreshing={providers.isRefetching}
			onRefresh={() => {
				if (!providers.isFetching) void providers.refetch();
			}}
			error={providers.isError}
			onRetry={() => void providers.refetch()}
			busy={providers.isFetching}
		/>
	);
}

function ProviderRow({
	provider,
	refresh,
}: {
	provider: SavedAiProvider;
	refresh: () => Promise<void>;
}) {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { aiProviders } = useMobileApi();
	const action = useAuthAction(scope.identity);
	const [editing, setEditing] = useState(false);
	const [label, setLabel] = useState(provider.label ?? "");
	const [valid, setValid] = useState<boolean | null>(null);
	return (
		<AppView className="gap-3 rounded-2xl bg-surface p-4">
			<AppText className="text-lg font-semibold text-foreground">
				{provider.label || provider.provider_id}
			</AppText>
			<AppText selectable className="text-sm text-muted">
				{provider.provider_id} · {provider.native_provider ?? provider.type}
			</AppText>
			<AppText className="text-sm text-muted">
				{t(provider.usable ? "providers.credentialPresent" : "providers.credentialMissing")}
			</AppText>
			{editing ? (
				<>
					<AppTextInput
						accessibilityLabel={t("providers.label")}
						value={label}
						onChangeText={setLabel}
						editable={!action.busy}
						maxLength={200}
						className="rounded-xl bg-background p-3 text-foreground"
					/>
					<NativeButton
						label={t("projects.save")}
						disabled={action.busy || !label.trim()}
						onPress={() =>
							void action.run(async (current) => {
								await read((signal) =>
									aiProviders.update(provider.provider_id, { label: label.trim() }, signal),
								);
								if (!current()) return;
								setEditing(false);
								await refresh();
							})
						}
					/>
					<NativeButton
						label={t("account.cancel")}
						disabled={action.busy}
						onPress={() => {
							setEditing(false);
							setLabel(provider.label ?? "");
						}}
					/>
				</>
			) : (
				<NativeButton
					label={t("providers.rename")}
					disabled={action.busy || !scope.isReady}
					onPress={() => setEditing(true)}
				/>
			)}
			<NativeButton
				label={t("providers.validate")}
				disabled={action.busy || !scope.isReady}
				onPress={() =>
					void action.run(async (current) => {
						setValid(null);
						const result = await read((signal) =>
							aiProviders.validate(provider.provider_id, signal),
						);
						if (current()) setValid(result.valid);
					})
				}
			/>
			{valid !== null ? (
				<AppText accessibilityRole="alert">
					{t(valid ? "providers.valid" : "providers.invalid")}
				</AppText>
			) : null}
			{action.error ? <AppText accessibilityRole="alert">{t("providers.failed")}</AppText> : null}
		</AppView>
	);
}
