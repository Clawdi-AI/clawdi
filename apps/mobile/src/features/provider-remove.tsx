import type { AiProviderRemovalImpact, AiProviderRemovalResult } from "@clawdi/shared/api";
import { aiProvidersPageClasses } from "@clawdi/shared/ui";
import { randomUUID } from "expo-crypto";
import { Trash2 } from "lucide-react-native";
import { useRef, useState } from "react";
import { useAuthAction } from "../auth/use-auth-action";
import { useI18n } from "../i18n";
import { useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useForegroundLease } from "../platform/use-foreground-lease";
import { useMobileApi } from "../providers/api-provider";
import { ActionButton, NativeSwitch } from "../ui/agents/controls";
import { Button } from "../ui/button";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../ui/dialog";
import { Icon } from "../ui/icon";
import { AppText, AppView } from "../ui/primitives";
import { webView } from "../ui/web-layout";

export function ProviderRemove({
	providerId,
	onRemoved,
}: {
	providerId: string;
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
				className={webView(aiProvidersPageClasses.mlAutoTextMuted)}
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
				className={webView(aiProvidersPageClasses.mlAutoTextMuted)}
				disabled={action.busy || !scope.isReady}
				onPress={() => {
					if (attempt.current) setOpen(true);
					else void review();
				}}
			>
				<Icon as={Trash2} />
			</Button>
			{open ? (
				<Dialog
					open={open}
					onOpenChange={(next) => {
						if (!next && !action.busy) {
							setOpen(false);
							setAcknowledged(false);
						}
					}}
				>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>{t("providers.reviewRemoval")}</DialogTitle>
						</DialogHeader>
						<AppText>{t("providers.removeWarning")}</AppText>
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
						<ActionButton
							label={t("providers.reviewCurrentImpact")}
							disabled={action.busy}
							onPress={() => void review()}
						/>
						{impact ? (
							<>
								<AppText>
									{t(
										impact.agents.length
											? "providers.affectedAgents"
											: "providers.noAffectedAgents",
									)}
								</AppText>
								{impact.agents.map((agent) => (
									<AppText selectable key={agent.deployment_id}>
										{agent.name} · {agent.deployment_id}
									</AppText>
								))}
								<NativeSwitch
									label={t("providers.acknowledgeRemoval")}
									value={acknowledged}
									disabled={action.busy}
									onValueChange={setAcknowledged}
								/>
								<ActionButton
									label={t("providers.removePermanently")}
									variant="destructive"
									disabled={action.busy || !acknowledged}
									onPress={() => void remove(false)}
								/>
							</>
						) : null}
						{action.error ? (
							<AppText accessibilityRole="alert">{t("providers.removalFailed")}</AppText>
						) : null}
						<ActionButton
							label={t("account.cancel")}
							disabled={action.busy}
							onPress={() => {
								setOpen(false);
								setAcknowledged(false);
							}}
						/>
					</DialogContent>
				</Dialog>
			) : null}
		</AppView>
	);
}
