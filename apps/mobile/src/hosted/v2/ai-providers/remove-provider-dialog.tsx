import type { AiProviderRemovalImpact, AiProviderRemovalResult } from "@clawdi/shared/api";
import { aiProvidersPageClasses } from "@clawdi/shared/ui";
import {
	providerRemovalCopy as copy,
	providerRemovalRevokesChatGpt,
	providerRemovalTitle,
	settingsCopy,
} from "@clawdi/shared/view";
import { randomUUID } from "expo-crypto";
import { router, useLocalSearchParams } from "expo-router";
import Trash2 from "lucide-react-native/icons/trash";
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
			accessibilityLabel={providerRemoval ? copy.remove : t("providers.removalUnavailable")}
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
			revokesChatGpt={providerRemovalRevokesChatGpt(provider.auth)}
			onRemoved={async () => {
				await refresh();
			}}
		/>
	);
}
/** Web's RemoveProviderAction dialog; a repeated Remove reuses the same idempotency key. */
function ProviderRemoveForm({
	providerId,
	providerLabel,
	revokesChatGpt,
	onRemoved,
}: {
	providerId: string;
	providerLabel: string;
	revokesChatGpt: boolean;
	onRemoved: (result: AiProviderRemovalResult) => Promise<void>;
}) {
	const scope = useAccountScope();
	const read = useAccountRead();
	const capture = useForegroundLease();
	const { providerRemoval } = useMobileApi();
	const check = useAuthAction(scope.identity);
	const action = useAuthAction(scope.identity);
	const sheet = useSheet<boolean>({ fallback: "/ai-providers", busy: action.busy });
	const [impact, setImpact] = useState<AiProviderRemovalImpact | null>(null);
	const [acknowledged, setAcknowledged] = useState(false);
	const [result, setResult] = useState<AiProviderRemovalResult | null>(null);
	const attempt = useRef<{ impact: AiProviderRemovalImpact; key: string } | null>(null);
	const review = () =>
		check.run(async (current) => {
			if (!providerRemoval) return;
			const visible = capture();
			if (!visible()) return;
			setImpact(null);
			setAcknowledged(false);
			const loaded = await read((signal) => providerRemoval.impact(providerId, signal));
			if (current() && visible()) setImpact(loaded);
		});
	const acknowledgementRequired = Boolean(impact?.agents.length);
	const remove = () =>
		action.run(async (current) => {
			if (!providerRemoval || !impact || (acknowledgementRequired && !acknowledged)) return;
			const visible = capture();
			if (!visible()) return;
			if (
				!attempt.current ||
				attempt.current.impact.impact_revision !== impact.impact_revision ||
				attempt.current.impact.provider_incarnation_token !== impact.provider_incarnation_token
			)
				attempt.current = { impact, key: randomUUID() };
			const submitting = attempt.current;
			const removed = await read((signal) =>
				providerRemoval.remove(submitting.impact, submitting.key, signal),
			);
			if (!current() || !visible()) return;
			attempt.current = null;
			setResult(removed);
			await onRemoved(removed);
		});

	const reviewRef = useRef(review);
	reviewRef.current = review;
	useEffect(() => {
		void reviewRef.current();
	}, []);
	if (result)
		return (
			<SheetPage title={copy.removed} fallback="/ai-providers" busy={action.busy} sheet={sheet}>
				<AppText accessibilityRole="alert">
					{result.remote_revoke_status === "pending" ? copy.removedPending : copy.removedConfirmed}
				</AppText>
				<ActionButton
					label={settingsCopy.done}
					disabled={action.busy}
					onPress={() => void action.run(() => sheet.close(true))}
				/>
			</SheetPage>
		);
	return (
		<SheetPage
			title={providerRemovalTitle(providerLabel)}
			fallback="/ai-providers"
			busy={action.busy}
			sheet={sheet}
		>
			<WebView recipe={aiProvidersPageClasses.removalDescription}>
				<AppText>{copy.description}</AppText>
				{revokesChatGpt ? <AppText>{copy.revocation}</AppText> : null}
				{check.busy ? (
					<AppText className={webView(aiProvidersPageClasses.impactLoading)}>
						{copy.checking}
					</AppText>
				) : check.error ? (
					<ApiErrorPanel
						error={check.failure}
						title={copy.impactError}
						onRetry={() => void review()}
					/>
				) : impact?.agents.length ? (
					<>
						<AppText>{copy.affected}</AppText>
						{impact.agents.map((agent) => (
							<AppText selectable key={agent.deployment_id}>
								{agent.name}
							</AppText>
						))}
					</>
				) : impact ? (
					<AppText>{copy.noAgents}</AppText>
				) : null}
			</WebView>
			{acknowledgementRequired ? (
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
			) : null}
			{action.error ? <ApiErrorPanel error={action.failure} title={copy.removeFailed} /> : null}
			<Button
				variant="destructive"
				disabled={
					action.busy ||
					check.busy ||
					check.error ||
					!impact ||
					(acknowledgementRequired && !acknowledged)
				}
				onPress={() => void remove()}
			>
				<Text>{copy.remove}</Text>
			</Button>
		</SheetPage>
	);
}
