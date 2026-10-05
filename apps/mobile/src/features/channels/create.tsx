import {
	discordApplicationIdError,
	discordBotTokenError,
	discordPublicKeyError,
} from "@clawdi/shared/api";
import { useFocusEffect } from "expo-router";
import { useCallback, useEffect, useState } from "react";
import { AppState } from "react-native";
import { useAuthAction } from "../../auth/use-auth-action";
import { useI18n } from "../../i18n";
import { useAccountRead, useAccountScope } from "../../platform/account-lifecycle";
import { useForegroundLease } from "../../platform/use-foreground-lease";
import { useMobileApi } from "../../providers/api-provider";
import { ActionButton, ChoiceSelect } from "../../ui/agents/controls";
import { Dialog, DialogContent, DialogHeader, DialogTitle } from "../../ui/dialog";
import { Input } from "../../ui/input";
import { AppText, AppView } from "../../ui/primitives";

export function ChannelCreate({ refresh }: { refresh: () => Promise<void> }) {
	const t = useI18n();
	const scope = useAccountScope();
	const read = useAccountRead();
	const { channels } = useMobileApi();
	const action = useAuthAction(scope.identity);
	const capture = useForegroundLease();
	const [open, setOpen] = useState(false);
	const [provider, setProvider] = useState<"telegram" | "discord">("telegram");
	const [name, setName] = useState("");
	const [token, setToken] = useState("");
	const [applicationId, setApplicationId] = useState("");
	const [publicKey, setPublicKey] = useState("");
	const [uncertain, setUncertain] = useState(false);
	const clear = useCallback(() => {
		setToken("");
		setApplicationId("");
		setPublicKey("");
		setOpen(false);
	}, []);
	useFocusEffect(useCallback(() => clear, [clear]));
	useEffect(() => {
		const listener = AppState.addEventListener("change", (state) => {
			if (state !== "active") clear();
		});
		return () => listener.remove();
	}, [clear]);
	const invalid =
		!name.trim() ||
		!token.trim() ||
		(provider === "discord" &&
			(!applicationId.trim() ||
				!publicKey.trim() ||
				Boolean(
					discordBotTokenError(token.trim()) ||
						discordApplicationIdError(applicationId) ||
						discordPublicKeyError(publicKey),
				)));
	return (
		<AppView className="gap-3">
			{uncertain ? (
				<AppText accessibilityRole="alert">{t("channels.createUncertain")}</AppText>
			) : null}
			{!open ? (
				<ActionButton
					label={t("channels.create")}
					disabled={action.busy || !scope.isReady}
					onPress={() => {
						action.clearError();
						setOpen(true);
					}}
				/>
			) : (
				<Dialog
					open={open}
					onOpenChange={(next) => {
						if (!next && !action.busy) {
							clear();
						}
					}}
				>
					<DialogContent>
						<DialogHeader>
							<DialogTitle>{t("channels.create")}</DialogTitle>
						</DialogHeader>
						<AppText>{t("channels.createInstructions")}</AppText>
						<ChoiceSelect
							value={provider}
							options={[
								{ value: "telegram", label: "Telegram" },
								{ value: "discord", label: "Discord" },
							]}
							disabled={action.busy || uncertain}
							onValueChange={(value) => {
								setProvider(value);
								setToken("");
							}}
						/>
						<Input
							accessibilityLabel={t("channels.name")}
							placeholder={t("channels.name")}
							value={name}
							onChangeText={setName}
							maxLength={120}
							editable={!action.busy && !uncertain}
						/>
						<Input
							accessibilityLabel={t("channels.token")}
							placeholder={t("channels.token")}
							value={token}
							onChangeText={setToken}
							maxLength={2000}
							secureTextEntry
							autoCapitalize="none"
							autoCorrect={false}
							editable={!action.busy && !uncertain}
						/>
						{provider === "discord" ? (
							<>
								<Input
									accessibilityLabel={t("channels.applicationId")}
									placeholder={t("channels.applicationId")}
									value={applicationId}
									onChangeText={setApplicationId}
									maxLength={20}
									autoCapitalize="none"
									autoCorrect={false}
									editable={!action.busy && !uncertain}
								/>
								<Input
									accessibilityLabel={t("channels.publicKey")}
									placeholder={t("channels.publicKey")}
									value={publicKey}
									onChangeText={setPublicKey}
									maxLength={64}
									autoCapitalize="none"
									autoCorrect={false}
									editable={!action.busy && !uncertain}
								/>
							</>
						) : null}
						<ActionButton
							label={t("channels.create")}
							disabled={action.busy || uncertain || invalid}
							onPress={() =>
								void action.run(async (current) => {
									const visible = capture();
									if (!visible() || invalid || uncertain) return;
									setUncertain(true);
									await read((signal) =>
										channels.create(
											{
												provider,
												name: name.trim(),
												provider_token: token.trim(),
												agent_id: null,
												...(provider === "discord"
													? {
															config: {
																application_id: applicationId.trim(),
																public_key: publicKey.trim(),
															},
														}
													: {}),
											},
											signal,
										),
									);
									if (!current() || !visible()) return;
									clear();
									setName("");
									setUncertain(false);
									await refresh();
								})
							}
						/>
						<ActionButton label={t("account.cancel")} disabled={action.busy} onPress={clear} />
					</DialogContent>
				</Dialog>
			)}
			{uncertain ? (
				<ActionButton
					label={t("channels.reviewInventory")}
					disabled={action.busy}
					onPress={() =>
						void action.run(async (current) => {
							const visible = capture();
							await refresh();
							if (current() && visible()) {
								clear();
								setUncertain(false);
							}
						})
					}
				/>
			) : null}
			{action.error ? <AppText accessibilityRole="alert">{t("channels.failed")}</AppText> : null}
		</AppView>
	);
}
