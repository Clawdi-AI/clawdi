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
import { NativeButton, NativePicker } from "../../ui/native-controls";
import { AppText, AppTextInput, AppView } from "../../ui/primitives";

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
				<NativeButton
					label={t("channels.create")}
					disabled={action.busy || !scope.isReady}
					onPress={() => {
						action.clearError();
						setOpen(true);
					}}
				/>
			) : (
				<>
					<AppText>{t("channels.createInstructions")}</AppText>
					<NativePicker
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
					<AppTextInput
						accessibilityLabel={t("channels.name")}
						placeholder={t("channels.name")}
						value={name}
						onChangeText={setName}
						maxLength={120}
						editable={!action.busy && !uncertain}
						className="rounded-xl bg-card p-3 text-foreground"
					/>
					<AppTextInput
						accessibilityLabel={t("channels.token")}
						placeholder={t("channels.token")}
						value={token}
						onChangeText={setToken}
						maxLength={2000}
						secureTextEntry
						autoCapitalize="none"
						autoCorrect={false}
						editable={!action.busy && !uncertain}
						className="rounded-xl bg-card p-3 text-foreground"
					/>
					{provider === "discord" ? (
						<>
							<AppTextInput
								accessibilityLabel={t("channels.applicationId")}
								placeholder={t("channels.applicationId")}
								value={applicationId}
								onChangeText={setApplicationId}
								maxLength={20}
								autoCapitalize="none"
								autoCorrect={false}
								editable={!action.busy && !uncertain}
								className="rounded-xl bg-card p-3 text-foreground"
							/>
							<AppTextInput
								accessibilityLabel={t("channels.publicKey")}
								placeholder={t("channels.publicKey")}
								value={publicKey}
								onChangeText={setPublicKey}
								maxLength={64}
								autoCapitalize="none"
								autoCorrect={false}
								editable={!action.busy && !uncertain}
								className="rounded-xl bg-card p-3 text-foreground"
							/>
						</>
					) : null}
					<NativeButton
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
					<NativeButton label={t("account.cancel")} disabled={action.busy} onPress={clear} />
				</>
			)}
			{uncertain ? (
				<NativeButton
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
