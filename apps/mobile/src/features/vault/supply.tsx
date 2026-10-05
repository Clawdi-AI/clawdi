import {
	ApiClientError,
	type components,
	importVaultSupplyRows,
	publicSessionId,
	type VaultSupplyRow,
	vaultRequestToken,
	vaultSupplyFields,
} from "@clawdi/shared/api";
import { vaultRequestClasses } from "@clawdi/shared/ui";
import { buildVaultSupplyAgentMessage, VAULT_REQUEST_COPY } from "@clawdi/shared/view";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { Alert, AppState, Share } from "react-native";
import { useAuthAction } from "../../auth/use-auth-action";
import { useI18n } from "../../i18n";
import { useAccountScope } from "../../platform/account-lifecycle";
import { incomingVaultLink } from "../../platform/incoming-link";
import { useForegroundLease } from "../../platform/use-foreground-lease";
import { useMobileApi } from "../../providers/api-provider";
import { Button } from "../../ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "../../ui/card";
import { Input, Label } from "../../ui/input";
import { AppScrollView, AppText, AppView } from "../../ui/primitives";
import { ReadScreen } from "../../ui/read-screen";
import { Text } from "../../ui/text";
import { SecretInput } from "../../ui/vault/secret-input";
import { WebText, WebView, webBoth, webView } from "../../ui/web-layout";
import { BackButton } from "../cloud-inventory";

type Context = components["schemas"]["VaultSecretRequestStatus"];
export function VaultSupplyScreen() {
	const scope = useAccountScope();
	const params = useLocalSearchParams<{ intake?: string }>();
	const intake = typeof params.intake === "string" ? publicSessionId(params.intake) : null;
	return <VaultSupply key={`${scope.identity}:${scope.generation}:${intake}`} intake={intake} />;
}
function VaultSupply({ intake }: { intake: string | null }) {
	const t = useI18n();
	const scope = useAccountScope();
	const { vaultSupply: api } = useMobileApi();
	const action = useAuthAction(scope);
	const capture = useForegroundLease();
	const token = useRef("");
	const pendingSupply = useRef<{
		token: string;
		fields: Record<string, string>;
		id: string;
	} | null>(null);
	const activeRequest = useRef<AbortController | null>(null);
	const [link, setLink] = useState("");
	const [incoming, setIncoming] = useState(false);
	const [context, setContext] = useState<Context>();
	const [rows, setRows] = useState<VaultSupplyRow[]>([]);
	const [envText, setEnvText] = useState("");

	const [phase, setPhase] = useState<"link" | "ready" | "done" | "unavailable" | "uncertain">(
		"link",
	);
	const [error, setError] = useState<"invalid" | "conflict" | "failed" | null>(null);
	const clearSecrets = useCallback(() => {
		token.current = "";
		pendingSupply.current = null;
		setLink("");
		setIncoming(false);
		setRows([]);
		setEnvText("");
	}, []);
	useFocusEffect(
		useCallback(() => {
			let focused = true;
			const retire = () => {
				activeRequest.current?.abort();
				clearSecrets();
				setContext(undefined);
				setPhase("link");
				setError(null);
			};
			const receive = () =>
				queueMicrotask(() => {
					// StrictMode's retired setup must not consume the one-shot capability.
					if (!focused || !intake || AppState.currentState !== "active") return;
					const received = incomingVaultLink.take(intake);
					if (!received) return;
					retire();
					token.current = vaultRequestToken(received) ?? "";
					setIncoming(Boolean(token.current));
				});
			receive();
			const listener = AppState.addEventListener("change", (state) => {
				if (state === "active") receive();
				else {
					if (intake) incomingVaultLink.clear(intake);
					retire();
				}
			});
			return () => {
				focused = false;
				listener.remove();
				retire();
			};
		}, [clearSecrets, intake]),
	);
	const requestSignal = () => {
		activeRequest.current?.abort();
		const controller = new AbortController();
		activeRequest.current = controller;
		return controller.signal;
	};
	const unavailable = () => {
		clearSecrets();
		setPhase("unavailable");
	};
	const load = () => {
		const visible = capture();
		void action.run(async (isCurrent) => {
			if (!visible()) return;
			const value = incoming ? token.current : vaultRequestToken(link);
			if (!value) {
				setError("invalid");
				return;
			}
			setError(null);
			setLink("");
			setIncoming(false);
			token.current = value;
			try {
				const result = await api.inspect(value, undefined, requestSignal());
				if (!isCurrent() || !visible()) return;
				if (result.status !== "pending") {
					unavailable();
					return;
				}
				setContext(result);
				setRows(result.fields.map((name) => ({ name, value: "", required: true })));
				setPhase("ready");
			} catch (caught) {
				if (!isCurrent() || !visible()) return;
				if (caught instanceof ApiClientError && caught.status === 410) unavailable();
				else {
					token.current = "";
					setError("failed");
				}
			}
		});
	};
	const prepare = () => {
		const visible = capture();
		const value = token.current;
		const initialContext = context;
		void action.run(async (isCurrent) => {
			if (!value || !initialContext || !visible() || phase !== "ready") return;
			setError(null);
			let fields: Record<string, string>;
			try {
				fields = vaultSupplyFields(rows, initialContext.fields);
			} catch {
				setError("invalid");
				return;
			}
			try {
				const inspected = await api.inspect(value, Object.keys(fields), requestSignal());
				if (!isCurrent() || !visible() || token.current !== value) return;
				if (inspected.status !== "pending" || inspected.id !== initialContext.id) {
					unavailable();
					return;
				}
				const warning = `${t("vault.supplyWarning")}\n${inspected.update_fields.join(", ") || t("vault.supplyNoUpdates")}`;
				pendingSupply.current = { token: value, fields, id: initialContext.id };
				Alert.alert(t("vault.supplySave"), warning, [
					{
						text: t("account.cancel"),
						style: "cancel",
						onPress: () => {
							pendingSupply.current = null;
						},
					},
					{
						text: t("vault.supplySave"),
						onPress: () => {
							if (!visible() || !pendingSupply.current) return;
							void action.run(async (stillCurrent) => {
								const pending = pendingSupply.current;
								if (!visible() || !pending || token.current !== pending.token) return;
								pendingSupply.current = null;
								setRows([]);
								setEnvText("");
								try {
									const result = await api.supply(pending.token, pending.fields, requestSignal());
									if (!stillCurrent() || !visible()) return;
									if (result.status !== "supplied" || result.id !== pending.id)
										throw new Error("Unconfirmed supply");
									clearSecrets();
									setContext(result);
									setPhase("done");
								} catch (caught) {
									if (!stillCurrent() || !visible()) return;
									clearSecrets();
									if (
										caught instanceof ApiClientError &&
										(caught.status === 409 || caught.status === 410)
									)
										setPhase("unavailable");
									else setPhase("uncertain");
								}
							});
						},
					},
				]);
			} catch (caught) {
				if (!isCurrent() || !visible()) return;
				if (caught instanceof ApiClientError && caught.status === 410) unavailable();
				else
					setError(
						caught instanceof ApiClientError && caught.status === 409 ? "conflict" : "failed",
					);
			}
		});
	};
	return (
		<ReadScreen>
			<AppScrollView
				contentContainerClassName={webView(vaultRequestClasses.page)}
				keyboardShouldPersistTaps="handled"
			>
				<BackButton />
				<Card className={webView(vaultRequestClasses.card)}>
					<CardHeader className={webView(vaultRequestClasses.header)}>
						<WebText recipe={vaultRequestClasses.brandName}>Clawdi</WebText>
						<CardTitle className={webBoth(vaultRequestClasses.title)}>
							{phase === "done"
								? VAULT_REQUEST_COPY.saved
								: phase === "unavailable"
									? VAULT_REQUEST_COPY.unavailableTitle
									: VAULT_REQUEST_COPY.title}
						</CardTitle>
					</CardHeader>
					<CardContent>
						<WebView recipe={vaultRequestClasses.form}>
							{phase === "link" ? (
								<>
									{incoming ? (
										<AppText>{t("vault.supplyReceived")}</AppText>
									) : (
										<Input
											accessibilityLabel={t("vault.supplyLink")}
											placeholder={t("vault.supplyLink")}
											value={link}
											onChangeText={setLink}
											maxLength={4096}
											secureTextEntry
											autoCorrect={false}
											autoCapitalize="none"
											autoComplete="off"
											textContentType="none"
											editable={!action.busy}
										/>
									)}
									<Button
										variant="outline"
										size="sm"
										disabled={action.busy || (!incoming && !link)}
										onPress={load}
									>
										<Text>{t("vault.supplyLoad")}</Text>
									</Button>
								</>
							) : null}
							{phase === "ready" && context ? (
								<>
									<AppText className="text-lg font-semibold text-foreground">
										{context.vault_name} · {context.project_name}
									</AppText>
									<AppText>
										{context.section || t("vault.defaultSection")} · {context.expires_at}
									</AppText>
									{rows.map((row, index) => (
										<AppView key={`${index}:${row.required}`} className="gap-2">
											{row.required ? (
												<Label>{row.name}</Label>
											) : (
												<Input
													accessibilityLabel={t("vault.supplyName")}
													placeholder={t("vault.supplyName")}
													value={row.name}
													maxLength={200}
													editable={!row.required && !action.busy}
													onChangeText={(name) =>
														setRows(rows.map((r, i) => (i === index ? { ...r, name } : r)))
													}
													autoCorrect={false}
													autoCapitalize="none"
												/>
											)}
											<SecretInput
												label={row.name || t("vault.supplyValue")}
												value={row.value}
												onChange={(value) =>
													setRows(rows.map((r, i) => (i === index ? { ...r, value } : r)))
												}
												disabled={action.busy}
												maxLength={131072}
											/>
											{!row.required ? (
												<Button
													variant="outline"
													size="sm"
													disabled={action.busy}
													onPress={() => setRows(rows.filter((_, i) => i !== index))}
												>
													<Text>{t("vault.supplyRemove")}</Text>
												</Button>
											) : null}
										</AppView>
									))}
									<Button
										variant="outline"
										size="sm"
										disabled={action.busy || rows.length >= 32}
										onPress={() => setRows([...rows, { name: "", value: "", required: false }])}
									>
										<Text>{t("vault.supplyAdd")}</Text>
									</Button>
									<Input
										accessibilityLabel={t("vault.supplyImport")}
										placeholder={t("vault.supplyImport")}
										value={envText}
										onChangeText={setEnvText}
										multiline
										maxLength={1048576}
										autoCorrect={false}
										autoCapitalize="none"
										autoComplete="off"
										textContentType="none"
										editable={!action.busy}
									/>
									<Button
										variant="outline"
										size="sm"
										disabled={action.busy || !envText}
										onPress={() => {
											try {
												setRows(importVaultSupplyRows(rows, envText));
												setEnvText("");
												setError(null);
											} catch {
												setError("invalid");
											}
										}}
									>
										<Text>{t("vault.supplyImport")}</Text>
									</Button>
									<Button
										variant="outline"
										size="sm"
										disabled={action.busy || !!envText}
										onPress={prepare}
									>
										<Text>{t("vault.supplyReview")}</Text>
									</Button>
								</>
							) : null}
							{phase === "done" ? (
								<>
									<AppText accessibilityRole="alert">{VAULT_REQUEST_COPY.done}</AppText>
									<Button
										variant="outline"
										size="sm"
										onPress={() => {
											const visible = capture();
											void action.run(async () => {
												if (context && visible())
													await Share.share({ message: buildVaultSupplyAgentMessage(context.id) });
											});
										}}
										disabled={action.busy}
									>
										<Text>{t("vault.supplyReceipt")}</Text>
									</Button>
								</>
							) : null}
							{phase === "unavailable" ? (
								<AppText accessibilityRole="alert">{VAULT_REQUEST_COPY.unavailable}</AppText>
							) : null}
							{phase === "uncertain" ? (
								<AppText accessibilityRole="alert">{t("vault.supplyUncertain")}</AppText>
							) : null}
							{error || action.error ? (
								<AppText accessibilityRole="alert">
									{t(
										error === "invalid"
											? "vault.supplyInvalid"
											: error === "conflict"
												? "vault.supplyConflict"
												: "vault.failed",
									)}
								</AppText>
							) : null}
							<Button
								variant="outline"
								size="sm"
								disabled={action.busy}
								onPress={() => {
									activeRequest.current?.abort();
									clearSecrets();
									setContext(undefined);
									setPhase("link");
									setError(null);
								}}
							>
								<Text>{t("vault.supplyReset")}</Text>
							</Button>
						</WebView>
					</CardContent>
				</Card>
			</AppScrollView>
		</ReadScreen>
	);
}
