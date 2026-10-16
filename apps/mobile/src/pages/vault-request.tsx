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
import {
	buildVaultSupplyAgentMessage,
	VAULT_REQUEST_COPY as copy,
	vaultRequestExpires,
	vaultRequestSection,
} from "@clawdi/shared/view";
import { useFocusEffect, useLocalSearchParams } from "expo-router";
import { useCallback, useRef, useState } from "react";
import { AppState, Share } from "react-native";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Input, Label } from "@/components/ui/input";
import { Text } from "@/components/ui/text";
import { AppImage, AppScrollView } from "@/components/ui/view";
import { WebText, WebView, webBoth, webView } from "@/components/ui/web-layout";
import { SecretInput } from "@/components/vault/secret-input";
import { useMobileApi } from "@/lib/api-provider";
import { useI18n } from "@/lib/i18n";
import { useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { incomingVaultLink } from "@/platform/incoming-link";
import { NativeHeader } from "@/platform/navigation/native-header";
import { SafeAreaScreen } from "@/platform/safe-area-screen";
import { useForegroundLease } from "@/platform/use-foreground-lease";

// The pre-rounded v2 mark, as on the account-suspended page.
const logo = require("../../assets/splash-icon.png");

type Context = components["schemas"]["VaultSecretRequestStatus"];
type Phase = "loading" | "ready" | "done" | "unavailable" | "error";

/** Web's VaultRequestPage. The capability arrives only through a request link. */
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
	const activeRequest = useRef<AbortController | null>(null);
	const [context, setContext] = useState<Context>();
	const [rows, setRows] = useState<VaultSupplyRow[]>([]);
	const [importOpen, setImportOpen] = useState(false);
	const [envText, setEnvText] = useState("");
	const [phase, setPhase] = useState<Phase>("loading");
	const [error, setError] = useState("");
	const clearSecrets = useCallback(() => {
		token.current = "";
		setRows([]);
		setEnvText("");
		setImportOpen(false);
	}, []);
	const requestSignal = () => {
		activeRequest.current?.abort();
		const controller = new AbortController();
		activeRequest.current = controller;
		return controller.signal;
	};
	const unavailable = useCallback(() => {
		clearSecrets();
		setPhase("unavailable");
	}, [clearSecrets]);
	const load = (value: string) => {
		const visible = capture();
		void action.run(async (isCurrent) => {
			setError("");
			setPhase("loading");
			try {
				const result = await api.inspect(value, undefined, requestSignal());
				if (!isCurrent() || !visible()) return;
				if (result.status !== "pending") return unavailable();
				setContext(result);
				setRows(result.fields.map((name) => ({ name, value: "", required: true })));
				setPhase("ready");
			} catch (caught) {
				if (!isCurrent() || !visible()) return;
				if (caught instanceof ApiClientError && [410, 422].includes(caught.status))
					return unavailable();
				setError(caught instanceof ApiClientError ? copy.loadFailed : copy.offline);
				setPhase("error");
			}
		});
	};
	// The focus effect reads the latest loader without re-subscribing on every render.
	const loadRef = useRef(load);
	loadRef.current = load;
	useFocusEffect(
		useCallback(() => {
			let focused = true;
			const retire = () => {
				activeRequest.current?.abort();
				clearSecrets();
				setContext(undefined);
				setError("");
				setPhase("unavailable");
			};
			const receive = () =>
				queueMicrotask(() => {
					// StrictMode's retired setup must not consume the one-shot capability.
					if (!focused || AppState.currentState !== "active") return;
					const received = intake ? incomingVaultLink.take(intake) : null;
					const value = received ? vaultRequestToken(received) : null;
					if (value) {
						token.current = value;
						loadRef.current(value);
					} else if (!token.current) setPhase("unavailable");
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
	const save = () => {
		const visible = capture();
		const value = token.current;
		const requested = context;
		void action.run(async (isCurrent) => {
			if (!value || !requested || !visible() || phase !== "ready" || importOpen) return;
			setError("");
			let fields: Record<string, string>;
			try {
				fields = vaultSupplyFields(rows, requested.fields);
			} catch {
				setError(copy.saveFailed);
				return;
			}
			try {
				const result = await api.supply(value, fields, requestSignal());
				if (!isCurrent() || !visible()) return;
				if (result.status !== "supplied" || result.id !== requested.id)
					throw new Error("Unconfirmed supply");
				clearSecrets();
				setContext(result);
				setPhase("done");
			} catch (caught) {
				if (!isCurrent() || !visible()) return;
				if (caught instanceof ApiClientError && caught.status === 410) unavailable();
				else if (caught instanceof ApiClientError && caught.status === 409)
					setError(copy.selectionConflict);
				else if (caught instanceof ApiClientError) setError(copy.saveFailed);
				else setError(copy.saveUncertain);
			}
		});
	};
	const agentMessage = phase === "done" && context ? buildVaultSupplyAgentMessage(context.id) : "";
	return (
		<SafeAreaScreen>
			<AppScrollView
				contentContainerClassName={webView(vaultRequestClasses.page)}
				keyboardShouldPersistTaps="handled"
			>
				<NativeHeader title={copy.title} />
				{phase === "loading" ? (
					<WebText recipe={vaultRequestClasses.loading} accessibilityRole="progressbar">
						{copy.loading}
					</WebText>
				) : (
					<Card className={webView(vaultRequestClasses.card)}>
						<CardHeader className={webView(vaultRequestClasses.header)}>
							<WebView recipe={vaultRequestClasses.brand} className="flex-row">
								<AppImage
									source={logo}
									accessibilityIgnoresInvertColors
									importantForAccessibility="no"
									className={webView(vaultRequestClasses.brandIcon)}
									resizeMode="contain"
								/>
								<WebText recipe={vaultRequestClasses.brandName}>{copy.brand}</WebText>
							</WebView>
							<CardTitle className={webBoth(vaultRequestClasses.title)}>
								{phase === "done"
									? copy.saved
									: phase === "unavailable"
										? copy.unavailableTitle
										: copy.title}
							</CardTitle>
						</CardHeader>
						<CardContent>
							<WebView recipe={vaultRequestClasses.form}>
								{phase === "unavailable" ? (
									<WebText recipe={vaultRequestClasses.muted} accessibilityRole="alert">
										{copy.unavailable}
									</WebText>
								) : null}
								{phase === "error" ? (
									<>
										<Text accessibilityRole="alert">{error}</Text>
										<WebView recipe={vaultRequestClasses.footer} className="flex-row">
											<Button onPress={() => load(token.current)} disabled={action.busy}>
												<Text>{copy.tryAgain}</Text>
											</Button>
										</WebView>
									</>
								) : null}
								{phase === "done" && agentMessage ? (
									<>
										<WebText recipe={vaultRequestClasses.muted} accessibilityRole="alert">
											{copy.done}
										</WebText>
										<WebText recipe={vaultRequestClasses.receipt} selectable>
											{agentMessage}
										</WebText>
										<WebView recipe={vaultRequestClasses.footer} className="flex-row">
											{/* The native share sheet carries Copy; mobile has no clipboard module. */}
											<Button
												disabled={action.busy}
												onPress={() => {
													const visible = capture();
													void action.run(async () => {
														if (visible()) await Share.share({ message: agentMessage });
													});
												}}
											>
												<Text>{t("vault.shareMessage")}</Text>
											</Button>
										</WebView>
									</>
								) : null}
								{phase === "ready" && context ? (
									<>
										<WebView recipe={vaultRequestClasses.context}>
											<WebText recipe={vaultRequestClasses.contextTitle}>
												{context.vault_name} · {context.project_name}
											</WebText>
											{context.section ? (
												<WebText recipe={vaultRequestClasses.wrap}>
													{vaultRequestSection(context.section)}
												</WebText>
											) : null}
											<WebText recipe={vaultRequestClasses.muted}>
												{vaultRequestExpires(context.expires_at)}
											</WebText>
										</WebView>
										<WebText recipe={vaultRequestClasses.loading}>{copy.privacy}</WebText>
										{context.update_fields.length ? (
											<WebText recipe={vaultRequestClasses.loading}>{copy.updateNote}</WebText>
										) : null}
										{rows.map((row, index) => (
											<WebView key={`${index}:${row.required}`} recipe={vaultRequestClasses.field}>
												<WebView recipe={vaultRequestClasses.fieldHeader} className="flex-row">
													{row.required ? (
														<Label>{row.name}</Label>
													) : (
														<Input
															accessibilityLabel={copy.fieldName}
															className={webBoth(vaultRequestClasses.mono)}
															value={row.name}
															maxLength={200}
															editable={!action.busy}
															onChangeText={(name) =>
																setRows(rows.map((r, i) => (i === index ? { ...r, name } : r)))
															}
															autoCorrect={false}
															autoCapitalize="none"
														/>
													)}
													{!row.required ? (
														<Button
															variant="ghost"
															disabled={action.busy}
															onPress={() => setRows(rows.filter((_, i) => i !== index))}
														>
															<Text>{copy.remove}</Text>
														</Button>
													) : null}
													{context.update_fields.includes(row.name) ? (
														<WebText recipe={vaultRequestClasses.update}>{copy.update}</WebText>
													) : null}
												</WebView>
												<SecretInput
													label={row.name || copy.fieldName}
													value={row.value}
													onChange={(value) =>
														setRows(rows.map((r, i) => (i === index ? { ...r, value } : r)))
													}
													disabled={action.busy}
													maxLength={65536}
												/>
											</WebView>
										))}
										<WebView recipe={vaultRequestClasses.actions} className="flex-row">
											<Button
												variant="outline"
												disabled={action.busy || rows.length >= 32 || importOpen}
												onPress={() => setRows([...rows, { name: "", value: "", required: false }])}
											>
												<Text>{copy.addField}</Text>
											</Button>
											<Button
												variant="outline"
												disabled={action.busy}
												onPress={() => {
													setImportOpen(true);
													setError("");
												}}
											>
												<Text>{copy.importEnv}</Text>
											</Button>
										</WebView>
										{importOpen ? (
											<WebView recipe={vaultRequestClasses.importPanel}>
												<Label>{copy.dotenvText}</Label>
												<SecretInput
													label={copy.dotenvText}
													value={envText}
													onChange={setEnvText}
													disabled={action.busy}
													maxLength={1048576}
												/>
												<Button
													disabled={action.busy || !envText}
													onPress={() => {
														try {
															setRows(importVaultSupplyRows(rows, envText));
															setEnvText("");
															setImportOpen(false);
															setError("");
														} catch {
															setError(copy.fieldsLimit);
														}
													}}
												>
													<Text>{copy.applyImport}</Text>
												</Button>
												<Button
													variant="ghost"
													disabled={action.busy}
													onPress={() => {
														setImportOpen(false);
														setEnvText("");
													}}
												>
													<Text>{copy.cancelImport}</Text>
												</Button>
											</WebView>
										) : null}
										{error ? (
											<WebText recipe={vaultRequestClasses.error} accessibilityRole="alert">
												{error}
											</WebText>
										) : null}
										<WebView recipe={vaultRequestClasses.footer} className="flex-row">
											<Button disabled={action.busy || importOpen} onPress={save}>
												<Text>{action.busy ? copy.saving : copy.save}</Text>
											</Button>
										</WebView>
									</>
								) : null}
							</WebView>
						</CardContent>
					</Card>
				)}
			</AppScrollView>
		</SafeAreaScreen>
	);
}
