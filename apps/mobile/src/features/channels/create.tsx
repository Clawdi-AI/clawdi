import {
	discordApplicationIdError,
	discordBotTokenError,
	discordPublicKeyError,
} from "@clawdi/shared/api";
import { connectBotDialogClasses as styles } from "@clawdi/shared/ui";
import { connectBotDialogCopy as copy, PROVIDER_META } from "@clawdi/shared/view";
import { router, useFocusEffect } from "expo-router";
import { ExternalLink, Plus } from "lucide-react-native";
import { useCallback, useEffect, useState } from "react";
import { AppState, Linking } from "react-native";
import { useAuthAction } from "../../auth/use-auth-action";
import { useI18n } from "../../i18n";
import { useAccountRead, useAccountScope } from "../../platform/account-lifecycle";
import { useForegroundLease } from "../../platform/use-foreground-lease";
import { useMobileApi } from "../../providers/api-provider";
import { ActionButton } from "../../ui/agents/controls";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "../../ui/dialog";
import { EntityChoiceCard } from "../../ui/entity-card";
import { EntityIcon } from "../../ui/entity-icon";
import { Icon } from "../../ui/icon";
import { Input, Label } from "../../ui/input";
import { AppText, AppView } from "../../ui/primitives";
import { WebText, WebView, webBoth, webView } from "../../ui/web-layout";

export function ChannelCreate({
	refresh,
	scoped = false,
}: {
	refresh: () => Promise<void>;
	scoped?: boolean;
}) {
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
					label={scoped ? "Add channel" : copy.title}
					icon={<Icon as={Plus} />}
					variant={scoped ? "outline" : "default"}
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
							<DialogTitle>{copy.title}</DialogTitle>
							<DialogDescription>{copy.description}</DialogDescription>
						</DialogHeader>
						<WebView recipe={styles.body}>
							<WebView recipe={styles.chooser}>
								<WebText recipe={styles.chooserTitle}>{copy.chooseProvider}</WebText>
								<WebView recipe={styles.choices}>
									{(["telegram", "discord", "whatsapp"] as const).map((id) => (
										<EntityChoiceCard
											key={id}
											variant="compact"
											className={webView(styles.choice)}
											icon={
												<EntityIcon
													kind="channel"
													id={id}
													label={PROVIDER_META[id].label}
													size="sm"
												/>
											}
											title={PROVIDER_META[id].label}
											selected={provider === id}
											disabled={action.busy || uncertain}
											onClick={() => {
												if (id === "whatsapp") {
													clear();
													router.push("/channels/whatsapp");
												} else {
													setProvider(id);
													setToken("");
												}
											}}
										/>
									))}
								</WebView>
								<WebText recipe={styles.unsupported}>
									{copy.unsupported}
									{copy.unsupportedInventory}
								</WebText>
							</WebView>

							<WebView recipe={styles.configuration}>
								<WebText recipe={styles.configurationTitle}>
									Configure {PROVIDER_META[provider].label}
								</WebText>
								<WebText recipe={styles.hint}>
									{provider === "telegram" ? copy.telegramSetupPrefix : copy.discordSetupPrefix}
									<WebText
										recipe={styles.setupLink}
										accessibilityRole="link"
										onPress={() =>
											void action.run(async () => {
												const url = PROVIDER_META[provider].setupUrl;
												if (url && capture()()) await Linking.openURL(url);
											})
										}
									>
										{provider === "telegram" ? copy.telegramSetup : copy.discordSetup}{" "}
										<Icon as={ExternalLink} className={webBoth(styles.setupIcon)} />
									</WebText>
								</WebText>
								<WebView recipe={styles.form}>
									<WebView recipe={styles.field}>
										<Label>{copy.name}</Label>
										<Input
											accessibilityLabel={t("channels.name")}
											placeholder={copy.namePlaceholder}
											value={name}
											onChangeText={setName}
											maxLength={120}
											editable={!action.busy && !uncertain}
										/>
									</WebView>
									<WebView recipe={styles.field}>
										<Label>{copy.token}</Label>
										<Input
											accessibilityLabel={t("channels.token")}
											placeholder={PROVIDER_META[provider].tokenPlaceholder}
											value={token}
											onChangeText={setToken}
											maxLength={2000}
											secureTextEntry
											autoCapitalize="none"
											autoCorrect={false}
											editable={!action.busy && !uncertain}
										/>
									</WebView>
									{provider === "discord" ? (
										<>
											<WebView recipe={styles.field}>
												<Label>{copy.applicationId}</Label>
												<Input
													accessibilityLabel={t("channels.applicationId")}
													placeholder={copy.applicationId}
													value={applicationId}
													onChangeText={setApplicationId}
													maxLength={20}
													autoCapitalize="none"
													autoCorrect={false}
													editable={!action.busy && !uncertain}
												/>
											</WebView>
											<WebView recipe={styles.field}>
												<Label>{copy.publicKey}</Label>
												<Input
													accessibilityLabel={t("channels.publicKey")}
													placeholder={copy.publicKeyPlaceholder}
													value={publicKey}
													onChangeText={setPublicKey}
													maxLength={64}
													autoCapitalize="none"
													autoCorrect={false}
													editable={!action.busy && !uncertain}
												/>
											</WebView>
										</>
									) : null}
									<DialogFooter>
										<ActionButton
											label={t("account.cancel")}
											disabled={action.busy}
											onPress={clear}
										/>
										<ActionButton
											label={copy.add}
											variant="default"
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
									</DialogFooter>
								</WebView>
							</WebView>
						</WebView>
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
