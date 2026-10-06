import type { AiProviderRemovalImpact, AiProviderRemovalResult } from "@clawdi/shared/api";
import { aiProvidersPageClasses } from "@clawdi/shared/ui";
import { providerRemovalCopy as copy } from "@clawdi/shared/view";
import { randomUUID } from "expo-crypto";
import { Trash2 } from "lucide-react-native";
import { useRef, useState } from "react";
import { ApiErrorPanel } from "@/components/api-error-panel";
import { useMobileApi } from "@/components/api-provider";
import { ActionButton } from "@/components/dashboard/controls";
import {
	AlertDialog,
	AlertDialogAction,
	AlertDialogCancel,
	AlertDialogContent,
	AlertDialogDescription,
	AlertDialogFooter,
	AlertDialogHeader,
	AlertDialogTitle,
} from "@/components/ui/alert-dialog";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Icon } from "@/components/ui/icon";
import { Label } from "@/components/ui/input";
import { AppText, AppView } from "@/components/ui/primitives";
import { Text } from "@/components/ui/text";
import { WebView, webView } from "@/components/ui/web-layout";
import { useI18n } from "@/lib/i18n";
import { useAccountRead, useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { useForegroundLease } from "@/platform/use-foreground-lease";

export function ProviderRemove({
	providerId,
	providerLabel = providerId,
	onRemoved,
}: {
	providerId: string;
	providerLabel?: string;
	onRemoved: (result: AiProviderRemovalResult) => Promise<void>;
}) {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const capture = useForegroundLease();
	const { providerRemoval } = useMobileApi();
	const action = useAuthAction(scope.identity);
	const [open, setOpen] = useState(false);
	const [impact, setImpact] = useState<AiProviderRemovalImpact | null>(null);
	const [acknowledged, setAcknowledged] = useState(false);
	const [uncertain, setUncertain] = useState(false);
	const attempt = useRef<{ impact: AiProviderRemovalImpact; key: string } | null>(null);
	const review = () =>
		action.run(async (current) => {
			if (!providerRemoval) return;
			const visible = capture();
			if (!visible()) return;
			setOpen(true);
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
			setOpen(false);
			setImpact(null);
			setAcknowledged(false);
			await onRemoved(result);
		});
	if (!providerRemoval)
		return (
			<Button
				variant="ghost"
				size="icon-sm"
				accessibilityLabel={t("providers.removalUnavailable")}
				disabled
				className={webView(aiProvidersPageClasses.removeAction)}
			>
				<Icon as={Trash2} />
			</Button>
		);
	return (
		<AppView className="gap-3">
			<Button
				accessibilityLabel={t("providers.reviewRemoval")}
				variant="ghost"
				size="icon-sm"
				className={webView(aiProvidersPageClasses.removeAction)}
				disabled={action.busy || !scope.isReady}
				onPress={() => {
					if (attempt.current) setOpen(true);
					else void review();
				}}
			>
				<Icon as={Trash2} />
			</Button>
			{open ? (
				<AlertDialog
					open={open}
					onOpenChange={(next) => {
						if (!next && !action.busy) {
							setOpen(false);
							setAcknowledged(false);
						}
					}}
				>
					<AlertDialogContent>
						<AlertDialogHeader>
							<AlertDialogTitle>{`Remove ${providerLabel}?`}</AlertDialogTitle>
							<AlertDialogDescription>{copy.description}</AlertDialogDescription>
						</AlertDialogHeader>
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
									/>
									<Label className="flex-1">{copy.acknowledge}</Label>
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
						<AlertDialogFooter>
							<AlertDialogCancel disabled={action.busy}>{copy.cancel}</AlertDialogCancel>
							<AlertDialogAction
								variant="destructive"
								disabled={action.busy || !impact || !acknowledged}
								onPress={() => void remove(false)}
							>
								<Text>{copy.remove}</Text>
							</AlertDialogAction>
						</AlertDialogFooter>
					</AlertDialogContent>
				</AlertDialog>
			) : null}
		</AppView>
	);
}
