import type { AiProviderRemovalImpact, AiProviderRemovalResult } from "@clawdi/shared/api";
import { aiProvidersPageClasses } from "@clawdi/shared/ui";
import { providerRemovalCopy as copy, settingsCopy } from "@clawdi/shared/view";
import { randomUUID } from "expo-crypto";
import { router, useLocalSearchParams } from "expo-router";
import { Trash2 } from "lucide-react-native";
import { useEffect, useRef, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { ActionButton } from "@/components/dashboard/controls";
import { ResourceError } from "@/components/resource-error";
import { RouteLoadingSkeleton } from "@/components/route-loading-skeleton";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Label } from "@/components/ui/input";
import { SheetPage } from "@/components/ui/sheet-page";
import { Text as AppText, Text } from "@/components/ui/text";
import { WebView, webView } from "@/components/ui/web-layout";
import {
	useProviderInventory,
	useRefreshProviders,
} from "@/hosted/v2/ai-providers/providers-hooks";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { useSheet } from "@/platform/navigation/use-sheet";
import { useForegroundLease } from "@/platform/use-foreground-lease";

export function ProviderRemove({ providerId }: { providerId: string }) {
	const t = useI18n();
	const scope = useAccountScope();
	const { providerRemoval } = useMobileApi();
	return (
		<Button
			accessibilityLabel={t(
				providerRemoval ? "providers.reviewRemoval" : "providers.removalUnavailable",
			)}
			variant="ghost"
			size="icon-sm"
			className={webView(aiProvidersPageClasses.removeAction)}
			disabled={!scope.isReady || !providerRemoval}
			onPress={() =>
				router.push({ pathname: "/ai-providers/[providerId]/remove", params: { providerId } })
			}
		>
			<Icon as={Trash2} />
		</Button>
	);
}
export function ProviderRemoveScreen() {
	const scope = useAccountScope();
	const { providerId } = useLocalSearchParams<{ providerId: string }>();
	const inventory = useProviderInventory();
	const refresh = useRefreshProviders();
	const provider = inventory.isError
		? undefined
		: inventory.data?.providers.find((item) => item.provider_id === providerId);
	if (!provider)
		return (
			<SheetPage title={copy.remove} fallback="/ai-providers">
				{inventory.isPending ? (
					<RouteLoadingSkeleton />
				) : inventory.isError ? (
					<ApiErrorPanel error={inventory.error} onRetry={() => void inventory.refetch()} />
				) : (
					<ResourceError missing />
				)}
			</SheetPage>
		);
	return (
		<ProviderRemoveForm
			key={`${scope.accountKey}:${scope.generation}:${providerId}`}
			providerId={providerId}
			providerLabel={provider.label ?? providerId}
			onRemoved={async () => {
				await refresh();
			}}
		/>
	);
}
function ProviderRemoveForm({
	providerId,
	providerLabel,
	onRemoved,
}: {
	providerId: string;
	providerLabel: string;
	onRemoved: (result: AiProviderRemovalResult) => Promise<void>;
}) {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const capture = useForegroundLease();
	const { providerRemoval } = useMobileApi();
	const action = useAuthAction(scope.identity);
	const sheet = useSheet<boolean>({ fallback: "/ai-providers", busy: action.busy });
	const [impact, setImpact] = useState<AiProviderRemovalImpact | null>(null);
	const [acknowledged, setAcknowledged] = useState(false);
	const [uncertain, setUncertain] = useState(false);
	const [result, setResult] = useState<AiProviderRemovalResult | null>(null);
	const attempt = useRef<{ impact: AiProviderRemovalImpact; key: string } | null>(null);
	const review = () =>
		action.run(async (current) => {
			if (!providerRemoval) return;
			const visible = capture();
			if (!visible()) return;
			setImpact(null);
			setAcknowledged(false);
			const result = await read((signal) => providerRemoval.impact(providerId, signal));
			if (current() && visible()) setImpact(result);
		});
	const remove = (retry: boolean) =>
		action.run(async (current) => {
			if (!providerRemoval) return;
			const visible = capture();
			if (!visible()) return;
			let saved = attempt.current;
			if (!retry) {
				if (!impact || !acknowledged) return;
				if (
					!saved ||
					saved.impact.impact_revision !== impact.impact_revision ||
					saved.impact.provider_incarnation_token !== impact.provider_incarnation_token
				) {
					saved = { impact, key: randomUUID() };
					attempt.current = saved;
				}
			}
			if (!saved) return;
			setUncertain(true);
			const submitting = saved;
			const result = await read((signal) =>
				providerRemoval.remove(submitting.impact, submitting.key, signal),
			);
			if (!current() || !visible()) return;
			attempt.current = null;
			setUncertain(false);
			setImpact(null);
			setAcknowledged(false);
			setResult(result);
			await onRemoved(result);
		});

	const reviewRef = useRef(review);
	reviewRef.current = review;
	useEffect(() => {
		void reviewRef.current();
	}, []);
	if (result)
		return (
			<SheetPage
				title={t("providers.removed")}
				fallback="/ai-providers"
				busy={action.busy}
				sheet={sheet}
			>
				<AppText accessibilityRole="alert">
					{result.remote_revoke_status === "pending"
						? t("providers.removedPending")
						: t("providers.removedConfirmed")}
				</AppText>
				{action.error ? <ApiErrorPanel error={action.error} /> : null}
				<ActionButton
					label={settingsCopy.done}
					disabled={action.busy}
					onPress={() =>
						void action.run(async () => {
							await onRemoved(result);
							await sheet.close(true);
						})
					}
				/>
			</SheetPage>
		);
	return (
		<SheetPage
			title={t("labels.removeProvider", { name: providerLabel })}
			description={copy.description}
			fallback="/ai-providers"
			busy={action.busy}
			sheet={sheet}
		>
			{uncertain ? (
				<AppText accessibilityRole="alert">{t("providers.removalUncertain")}</AppText>
			) : null}
			{attempt.current ? (
				<ActionButton
					label={t("providers.retryRemoval")}
					disabled={action.busy}
					onPress={() => void remove(true)}
				/>
			) : null}
			{impact || attempt.current || uncertain ? (
				<ActionButton
					label={t("providers.reviewCurrentImpact")}
					disabled={action.busy}
					onPress={() => void review()}
				/>
			) : null}
			{impact ? (
				<>
					<AppText>{impact.agents.length ? copy.affected : copy.noAgents}</AppText>
					{impact.agents.map((agent) => (
						<AppText selectable key={agent.deployment_id}>
							{agent.name}
						</AppText>
					))}
					<WebView recipe={aiProvidersPageClasses.acknowledgement} className="flex-row">
						<Checkbox
							checked={acknowledged}
							disabled={action.busy}
							onCheckedChange={setAcknowledged}
							accessibilityLabel={copy.acknowledge}
						/>
						<Label
							className="flex-1"
							accessibilityElementsHidden
							importantForAccessibility="no"
							onPress={action.busy ? undefined : () => setAcknowledged(!acknowledged)}
						>
							{copy.acknowledge}
						</Label>
					</WebView>
				</>
			) : null}
			{action.error && !attempt.current && !uncertain ? (
				<ApiErrorPanel
					error={action.error}
					title={copy.impactError}
					onRetry={() => void review()}
				/>
			) : action.error ? (
				<AppText accessibilityRole="alert">{t("providers.removalFailed")}</AppText>
			) : null}
			<Button
				variant="destructive"
				disabled={action.busy || !impact || !acknowledged}
				onPress={() => void remove(false)}
			>
				<Text>{copy.remove}</Text>
			</Button>
		</SheetPage>
	);
}
