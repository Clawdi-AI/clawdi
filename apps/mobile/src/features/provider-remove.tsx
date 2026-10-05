import type { AiProviderRemovalImpact, AiProviderRemovalResult } from "@clawdi/shared/api";
import { randomUUID } from "expo-crypto";
import { useRef, useState } from "react";
import { useAuthAction } from "../auth/use-auth-action";
import { useI18n } from "../i18n";
import { useAccountRead, useAccountScope } from "../platform/account-lifecycle";
import { useForegroundLease } from "../platform/use-foreground-lease";
import { useMobileApi } from "../providers/api-provider";
import { NativeButton, NativeSwitch } from "../ui/native-controls";
import { AppText, AppView } from "../ui/primitives";

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
			<AppText className="text-sm text-muted-foreground">
				{t("providers.removalUnavailable")}
			</AppText>
		);
	return (
		<AppView className="gap-3">
			<NativeButton
				label={t("providers.reviewRemoval")}
				disabled={action.busy || !scope.isReady}
				onPress={() => {
					if (attempt.current) setOpen(true);
					else void review();
				}}
			/>
			{open ? (
				<>
					<AppText>{t("providers.removeWarning")}</AppText>
					{uncertain ? (
						<AppText accessibilityRole="alert">{t("providers.removalUncertain")}</AppText>
					) : null}
					{attempt.current ? (
						<NativeButton
							label={t("providers.retryRemoval")}
							disabled={action.busy}
							onPress={() => void remove(true)}
						/>
					) : null}
					<NativeButton
						label={t("providers.reviewCurrentImpact")}
						disabled={action.busy}
						onPress={() => void review()}
					/>
					{impact ? (
						<>
							<AppText>
								{t(
									impact.agents.length ? "providers.affectedAgents" : "providers.noAffectedAgents",
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
							<NativeButton
								label={t("providers.removePermanently")}
								disabled={action.busy || !acknowledged}
								onPress={() => void remove(false)}
							/>
						</>
					) : null}
					{action.error ? (
						<AppText accessibilityRole="alert">{t("providers.removalFailed")}</AppText>
					) : null}
					<NativeButton
						label={t("account.cancel")}
						disabled={action.busy}
						onPress={() => {
							setOpen(false);
							setAcknowledged(false);
						}}
					/>
				</>
			) : null}
		</AppView>
	);
}
