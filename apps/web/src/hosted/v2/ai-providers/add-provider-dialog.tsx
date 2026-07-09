"use client";

import { CircleAlert, ExternalLink } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { EntityChoiceCard } from "@/components/entity-card";
import { EntityIcon } from "@/components/entity-icon";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import {
	Select,
	SelectContent,
	SelectItem,
	SelectTrigger,
	SelectValue,
} from "@/components/ui/select";
import { Spinner } from "@/components/ui/spinner";
import { Textarea } from "@/components/ui/textarea";
import {
	type AuthMethod,
	apiKeyEditState,
	derivedProviderFields,
	isAuthMethod,
	modelsFromText,
	modelsToText,
	parseModelIds,
	providerAuthForSubmit,
	providerFormIdentity,
	shouldUseCatalogModels,
} from "@/hosted/v2/ai-providers/add-provider-dialog.logic";
import {
	useAiProviders,
	useDeleteProviderQuiet,
	useOAuthComplete,
	useOAuthStart,
	useSetApiKey,
	useUpsertProvider,
	useUpsertProviderQuiet,
	useValidateProvider,
} from "@/hosted/v2/ai-providers/ai-providers-hooks";
import { ProviderTypeChip } from "@/hosted/v2/ai-providers/ai-providers-ui";
import {
	CLAWDI_CODEX_OAUTH_PROVIDER_ID,
	CODEX_OAUTH_CHANNEL,
	CODEX_OAUTH_STORAGE_KEY,
	type CodexOAuthResult,
	codexProviderBody,
	codexRedirectUri,
	parseCodexCallback,
} from "@/hosted/v2/ai-providers/codex-oauth";
import {
	API_MODE_LABEL,
	type ApiMode,
	PROVIDER_TYPES,
	type ProviderTypeId,
	providerTypeMeta,
} from "@/hosted/v2/ai-providers/provider-types";
import type { AiProvider } from "@/hosted/v2/ai-providers/types";

function isApiMode(value: string | null): value is ApiMode {
	return (
		value === "openai_chat" ||
		value === "openai_responses" ||
		value === "anthropic_messages" ||
		value === "google_generate_content"
	);
}

// Backend rule (_validate_base_url): `none` auth is only allowed for a loopback
// or RFC-1918 private base_url. Mirror it so the form blocks early with a hint
// instead of a generic 422.
function isLoopbackOrPrivateUrl(raw: string): boolean {
	let host: string;
	try {
		host = new URL(raw).hostname;
	} catch {
		return false;
	}
	if (host === "localhost" || host === "127.0.0.1" || host === "::1" || host === "0.0.0.0")
		return true;
	if (/^10\./.test(host) || /^192\.168\./.test(host)) return true;
	if (/^172\.(1[6-9]|2\d|3[01])\./.test(host)) return true;
	return false;
}

function providerTypeDescription(type: ProviderTypeId): string {
	if (type === "openai") return "OpenAI APIs";
	if (type === "anthropic") return "Claude models";
	if (type === "openrouter") return "Router models";
	if (type === "gemini") return "Google models";
	if (type === "mistral") return "Mistral APIs";
	return "Custom endpoint";
}

export function AddProviderDialog({
	open,
	onOpenChange,
	editing,
	onCreated,
}: {
	open: boolean;
	onOpenChange: (open: boolean) => void;
	editing?: AiProvider | null;
	onCreated?: (providerId: string) => void;
}) {
	const providers = useAiProviders();
	const upsert = useUpsertProvider();
	const upsertQuiet = useUpsertProviderQuiet();
	const deleteProviderQuiet = useDeleteProviderQuiet();
	const setKey = useSetApiKey();
	const validate = useValidateProvider();
	const oauthStart = useOAuthStart();
	const oauthComplete = useOAuthComplete();

	const isEdit = Boolean(editing);
	const [type, setType] = useState<ProviderTypeId>("openai");
	const [label, setLabel] = useState("");
	const [baseUrl, setBaseUrl] = useState("");
	const [modelsText, setModelsText] = useState("");
	const [apiMode, setApiMode] = useState<ApiMode>("openai_chat");
	const [runtimeEnv, setRuntimeEnv] = useState("");
	const [authMethod, setAuthMethod] = useState<AuthMethod>("api_key");
	const [apiKey, setApiKey] = useState("");

	// OAuth sub-flow
	const [oauth, setOauth] = useState<{
		providerId: string;
		state: string;
		authUrl: string;
		redirectUri: string;
		expiresAt: string;
	} | null>(null);
	const [oauthCode, setOauthCode] = useState("");
	// "closed" = the popup was closed before completing; "expired" = the start
	// session timed out; "blocked" = the browser blocked the pop-up. All three
	// stop the spinner and surface a recover-from-here CTA — recovery always
	// re-runs `oauth/start` for a FRESH link (a stale/expired/consumed start
	// can't be reopened), never reuses `oauth.authUrl`.
	const [oauthIssue, setOauthIssue] = useState<"closed" | "expired" | "blocked" | null>(null);
	// Guards a single completion across the three callback channels; finishRef
	// holds the latest completion closure for the listener effect.
	const completedRef = useRef(false);
	const abandonedRef = useRef(false);
	const finishRef = useRef<(r: CodexOAuthResult) => void>(() => {});
	// The sign-in popup handle (to poll `closed`) and whether THIS flow created
	// the canonical openai-codex provider (so an abandon cleans up only our own
	// orphan, never a pre-existing connected provider).
	const popupRef = useRef<Window | null>(null);
	const createdFreshRef = useRef(false);

	const meta = providerTypeMeta(type);
	const existingProviderIds =
		providers.data?.providers.map((provider) => provider.provider_id) ?? [];
	const catalogManaged = shouldUseCatalogModels(type, authMethod);
	const identity = providerFormIdentity({
		type,
		authMethod,
		labelInput: label,
		existingProviderIds,
		editing,
	});
	const providerId = identity.providerId;
	const providerLabel = identity.label ?? (providerId || meta.label);
	const runtimeEnvForSubmit = runtimeEnv.trim() || meta.defaultRuntimeEnv;
	const authMethodItems = [
		{ value: "api_key", label: "API key" },
		...(meta.oauth ? [{ value: "oauth", label: "Sign in with ChatGPT (Codex)" }] : []),
		...(meta.custom ? [{ value: "none", label: "No auth (local)" }] : []),
	];
	const showAuthMethodField = authMethodItems.length > 1;
	const showNameField = meta.custom === true;
	const showAdvancedFields = meta.custom === true;
	const showRuntimeEnvField = authMethod === "api_key" && showAdvancedFields;
	const apiModeItems = meta.apiModes.map((mode) => ({
		value: mode,
		label: API_MODE_LABEL[mode],
	}));
	const catalogModelIds = parseModelIds(modelsText);
	const catalogSummary =
		catalogModelIds.length > 3
			? `${catalogModelIds.slice(0, 3).join(", ")} +${catalogModelIds.length - 3} more`
			: catalogModelIds.join(", ");

	// Initialize when (re)opened.
	useEffect(() => {
		if (!open) return;
		setOauth(null);
		setOauthCode("");
		setOauthIssue(null);
		setApiKey("");
		completedRef.current = false;
		abandonedRef.current = false;
		createdFreshRef.current = false;
		popupRef.current = null;
		if (editing) {
			const nextType = editing.type as ProviderTypeId;
			const nextAuthMethod =
				editing.auth.type === "none"
					? "none"
					: editing.auth.type === "api_key" || editing.auth.type === "secret_ref"
						? "api_key"
						: "oauth";
			const defaults = derivedProviderFields(nextType, nextAuthMethod);
			const existingModels = editing.models ?? [];
			setType(nextType);
			setLabel(editing.label ?? "");
			setBaseUrl(editing.base_url || defaults.baseUrl);
			setModelsText(
				existingModels.length > 0 || !shouldUseCatalogModels(nextType, nextAuthMethod)
					? modelsToText(existingModels)
					: defaults.modelsText,
			);
			setApiMode(editing.api_mode ?? defaults.apiMode);
			setRuntimeEnv(editing.runtime_env_name ?? defaults.runtimeEnv);
			setAuthMethod(nextAuthMethod);
		} else {
			const defaults = derivedProviderFields("openai", "api_key");
			setType("openai");
			setLabel("");
			setBaseUrl(defaults.baseUrl);
			setModelsText(defaults.modelsText);
			setApiMode(defaults.apiMode);
			setRuntimeEnv(defaults.runtimeEnv);
			setAuthMethod("api_key");
		}
	}, [open, editing]);

	// Prefill when the type changes (add mode only).
	function changeType(next: ProviderTypeId) {
		const m = providerTypeMeta(next);
		let nextAuthMethod = authMethod;
		if (!m.oauth && nextAuthMethod === "oauth") nextAuthMethod = "api_key";
		if (!m.custom && nextAuthMethod === "none") nextAuthMethod = "api_key";
		const defaults = derivedProviderFields(next, nextAuthMethod);
		setType(next);
		setBaseUrl(defaults.baseUrl);
		setModelsText(defaults.modelsText);
		setApiMode(defaults.apiMode);
		setRuntimeEnv(defaults.runtimeEnv);
		setAuthMethod(nextAuthMethod);
		setApiKey("");
		if (next === "custom_openai_compatible") setLabel("");
	}

	function changeAuthMethod(next: AuthMethod) {
		setAuthMethod(next);
		setApiKey("");
		if (meta.custom) return;
		const defaults = derivedProviderFields(type, next);
		setBaseUrl(defaults.baseUrl);
		setModelsText(defaults.modelsText);
		setApiMode(defaults.apiMode);
		setRuntimeEnv(defaults.runtimeEnv);
	}

	// `none` auth only works with a loopback/private base_url (backend rule).
	const noneAuthOk = authMethod !== "none" || isLoopbackOrPrivateUrl(baseUrl.trim());
	const apiKeyState = isEdit
		? apiKeyEditState(authMethod, editing?.auth)
		: apiKeyEditState(authMethod, null);
	const { keyRequired, labelSuffix: apiKeyLabelSuffix, helpText: apiKeyHelpText } = apiKeyState;
	const canSubmit =
		Boolean(providerId) &&
		Boolean(baseUrl.trim()) &&
		noneAuthOk &&
		(!keyRequired || apiKey.trim().length > 0);

	async function submit() {
		if (!canSubmit) return;

		// Codex "Sign in with ChatGPT": create the canonical openai-codex provider
		// with the app callback redirect, then open ChatGPT. The callback route
		// hands code+state back and we complete automatically (paste path in
		// the sub-screen). redirect_uri stays identical across start/complete.
		if (authMethod === "oauth") {
			const redirectUri = codexRedirectUri();
			if (!providers.isSuccess) {
				toast.error("Provider list not ready", {
					description: providers.isLoading
						? "Wait for providers to finish loading, then try again."
						: "Refresh providers, then try again.",
				});
				return;
			}
			// The canonical openai-codex provider must exist before `start`, but it
			// isn't connected until `complete`. Only create it (quietly, without
			// invalidating the list) if it doesn't already exist — so we never
			// clobber a previously-connected provider, and an abandon cleans up
			// only the record we ourselves created.
			const existingCodex = providers.data.providers.some(
				(p) => p.provider_id === CLAWDI_CODEX_OAUTH_PROVIDER_ID,
			);
			if (!existingCodex) {
				const codexCreated = await upsertQuiet.mutateAsync(codexProviderBody()).catch(() => null);
				if (!codexCreated) return; // upsertQuiet.onError already toasts
				createdFreshRef.current = true;
			} else {
				createdFreshRef.current = false;
			}
			const started = await oauthStart
				.mutateAsync({
					providerId: CLAWDI_CODEX_OAUTH_PROVIDER_ID,
					provider: "codex",
					redirect_uri: redirectUri,
				})
				.catch(() => null);
			if (!started) {
				// Couldn't start — don't leave our just-created placeholder behind.
				if (createdFreshRef.current) {
					deleteProviderQuiet.mutate(CLAWDI_CODEX_OAUTH_PROVIDER_ID);
					createdFreshRef.current = false;
				}
				return; // oauthStart.onError already toasts
			}
			completedRef.current = false;
			abandonedRef.current = false;
			setOauthIssue(null);
			try {
				localStorage.removeItem(CODEX_OAUTH_STORAGE_KEY);
			} catch {}
			setOauth({
				providerId: CLAWDI_CODEX_OAUTH_PROVIDER_ID,
				state: started.state,
				authUrl: started.auth_url,
				redirectUri,
				expiresAt: started.expires_at,
			});
			openSignIn(started.auth_url);
			return;
		}

		const isApiKeySubmit = authMethod === "api_key";
		const hasNewManagedKey = isApiKeySubmit && Boolean(apiKey.trim());
		const auth = providerAuthForSubmit({
			authMethod,
			editingAuth: editing?.auth,
			hasNewManagedKey,
		});

		const keyBacked = auth.type === "api_key" || auth.type === "secret_ref";
		const body = {
			provider_id: providerId,
			type,
			label: identity.label,
			base_url: baseUrl.trim(),
			models: modelsFromText(modelsText, editing?.models),
			api_mode: apiMode,
			auth,
			managed_by: "user" as const,
			runtime_env_name: keyBacked ? runtimeEnvForSubmit : null,
		};
		const created = await upsert.mutateAsync(body).catch(() => null);
		if (!created) return;

		if (hasNewManagedKey) {
			// Don't claim success on a key that didn't store — `/validate` only
			// re-checks config shape, not that the key landed. setKey's onError
			// already toasts; keep the dialog open so the user can retry.
			const keyStored = await setKey
				.mutateAsync({
					providerId,
					value: apiKey.trim(),
					runtime_env_name: runtimeEnvForSubmit,
				})
				.catch(() => null);
			if (!keyStored) {
				if (!isEdit) await deleteProviderQuiet.mutateAsync(providerId).catch(() => null);
				return;
			}
		}

		// The provider IS saved at this point. `validate` is a post-save config
		// check — distinguish its three outcomes honestly: invalid config,
		// couldn't-run (network/throw → null), or clean.
		const saved = isEdit ? "Provider updated" : "Provider added";
		const result = await validate.mutateAsync(providerId).catch(() => null);
		if (result && !result.valid) {
			toast.warning("Provider saved with issues", { description: result.errors.join(" · ") });
		} else if (!result) {
			toast.success(saved, { description: "Couldn't run validation — check it from the list." });
		} else {
			toast.success(saved);
		}
		if (!isEdit) onCreated?.(created.provider_id);
		onOpenChange(false);
	}

	function openSignIn(url: string) {
		setOauthIssue(null);
		// window.open returns null (no throw) when the popup is blocked.
		const win = window.open(url, "codex-oauth", "width=520,height=720");
		popupRef.current = win;
		if (!win) {
			// Persist a recoverable state (not just a toast) so the dialog swaps the
			// "waiting…" spinner for a click-to-retry affordance.
			setOauthIssue("blocked");
			toast.error("Pop-up blocked", {
				description: "Allow pop-ups for this site, then use “Restart ChatGPT sign-in” below.",
			});
		}
	}

	/**
	 * Re-run `oauth/start` to mint a FRESH auth_url (+state +expires_at), then
	 * open it. An expired, consumed, or otherwise stale start session can't be
	 * reopened — reusing `oauth.authUrl` just dead-ends — so every in-dialog
	 * recovery (expired / closed / pop-up blocked) restarts rather than reopening.
	 */
	async function restartSignIn() {
		if (!oauth || oauthStart.isPending) return;
		const started = await oauthStart
			.mutateAsync({
				providerId: oauth.providerId,
				provider: "codex",
				redirect_uri: oauth.redirectUri,
			})
			.catch(() => null);
		if (!started) return; // oauthStart.onError already toasts
		completedRef.current = false;
		abandonedRef.current = false;
		try {
			localStorage.removeItem(CODEX_OAUTH_STORAGE_KEY);
		} catch {}
		// Fresh session resets the expiry/poll effect (keyed on `oauth`).
		setOauth({
			providerId: oauth.providerId,
			state: started.state,
			authUrl: started.auth_url,
			redirectUri: oauth.redirectUri,
			expiresAt: started.expires_at,
		});
		openSignIn(started.auth_url);
	}

	function closeOAuthPopup() {
		const popup = popupRef.current;
		try {
			if (popup && !popup.closed) popup.close();
		} catch {}
		popupRef.current = null;
	}

	/**
	 * Remove the placeholder provider we created if sign-in is left unfinished.
	 *
	 * This covers closing the DIALOG only. If the user closes the browser tab
	 * mid-OAuth this never runs, and we deliberately don't reconcile the orphan on
	 * next mount: AiProviderResponse exposes no verified/status field, and a
	 * never-completed placeholder is byte-for-byte identical to a connected Codex
	 * provider (both `auth: {agent_profile, codex, default}`). Any client-side
	 * "looks incomplete" heuristic would risk deleting a legitimately connected
	 * provider, so honest reconciliation needs backend completion state the
	 * dashboard doesn't have.
	 */
	function abandonCodexIfIncomplete() {
		if (!oauth) return;
		if (!completedRef.current && createdFreshRef.current) {
			deleteProviderQuiet.mutate(oauth.providerId);
			createdFreshRef.current = false;
		}
		abandonedRef.current = true;
		completedRef.current = true;
		closeOAuthPopup();
		setOauth(null);
		setOauthCode("");
		setOauthIssue(null);
		try {
			localStorage.removeItem(CODEX_OAUTH_STORAGE_KEY);
		} catch {}
	}

	function requestClose(next: boolean) {
		if (!next) abandonCodexIfIncomplete();
		onOpenChange(next);
	}

	function submitPastedCallback() {
		const parsed = parseCodexCallback(oauthCode);
		if (!parsed) {
			toast.error("Couldn't read that", {
				description: "Paste the full address from the OpenAI page after signing in.",
			});
			return;
		}
		finishRef.current(parsed);
	}

	// Keep the latest completion handler in a ref so the cross-window listener
	// (set up once per oauth session) always calls the current closure.
	finishRef.current = async (result: CodexOAuthResult) => {
		if (!oauth || completedRef.current || abandonedRef.current) return;
		if (result.error || !result.code) {
			if (result.error) toast.error("ChatGPT sign-in failed", { description: result.error });
			return;
		}
		completedRef.current = true;
		const done = await oauthComplete
			.mutateAsync({
				providerId: oauth.providerId,
				state: result.state || oauth.state,
				code: result.code,
				redirect_uri: oauth.redirectUri,
			})
			.catch(() => null);
		if (abandonedRef.current) return;
		if (done) {
			toast.success("Signed in with ChatGPT");
			createdFreshRef.current = false;
			closeOAuthPopup();
			setOauth(null);
			if (!isEdit) onCreated?.(oauth.providerId);
			onOpenChange(false);
		} else {
			completedRef.current = false; // allow retry
		}
	};

	// While a Codex sign-in is in flight, listen for the callback route handing
	// back code+state over any of three channels (postMessage, BroadcastChannel,
	// localStorage) and complete automatically.
	useEffect(() => {
		if (!oauth) return;
		const handle = (r: CodexOAuthResult | null) => {
			if (r) finishRef.current(r);
		};
		let ch: BroadcastChannel | null = null;
		try {
			ch = new BroadcastChannel(CODEX_OAUTH_CHANNEL);
			ch.onmessage = (e) => handle(e.data as CodexOAuthResult);
		} catch {}
		const onMessage = (e: MessageEvent) => {
			if (e.origin === window.location.origin && e.data?.source === CODEX_OAUTH_CHANNEL) {
				handle(e.data as CodexOAuthResult);
			}
		};
		const onStorage = (e: StorageEvent) => {
			if (e.key === CODEX_OAUTH_STORAGE_KEY && e.newValue) {
				try {
					handle(JSON.parse(e.newValue) as CodexOAuthResult);
				} catch {}
			}
		};
		window.addEventListener("message", onMessage);
		window.addEventListener("storage", onStorage);
		return () => {
			ch?.close();
			window.removeEventListener("message", onMessage);
			window.removeEventListener("storage", onStorage);
		};
	}, [oauth]);

	// Don't spin forever: surface when the sign-in popup is closed before it
	// completes, and when the start session expires (`expires_at`).
	useEffect(() => {
		if (!oauth) return;
		const poll = setInterval(() => {
			if (completedRef.current) return;
			if (popupRef.current?.closed) setOauthIssue((cur) => cur ?? "closed");
		}, 800);
		const remaining = new Date(oauth.expiresAt).getTime() - Date.now();
		const expiry = Number.isFinite(remaining)
			? setTimeout(
					() => {
						if (!completedRef.current) setOauthIssue("expired");
					},
					Math.max(remaining, 0),
				)
			: undefined;
		return () => {
			clearInterval(poll);
			if (expiry) clearTimeout(expiry);
		};
	}, [oauth]);

	const busy =
		upsert.isPending ||
		upsertQuiet.isPending ||
		deleteProviderQuiet.isPending ||
		setKey.isPending ||
		validate.isPending ||
		oauthStart.isPending;

	return (
		<Dialog open={open} onOpenChange={requestClose}>
			<DialogContent
				data-hosted="true"
				data-v2="true"
				className="flex max-h-[min(90vh,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-lg"
			>
				{oauth ? (
					<>
						<DialogHeader className="shrink-0 px-6 pt-6">
							<DialogTitle>Sign in with ChatGPT</DialogTitle>
							<DialogDescription>
								Finish signing in in the ChatGPT window — we’ll connect Codex automatically when it
								returns.
							</DialogDescription>
						</DialogHeader>
						<div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
							<div className="flex flex-col gap-3">
								<Button
									variant="outline"
									className="w-full"
									onClick={() => {
										// An issue means the prior link is stale — mint a fresh one. With no
										// issue the popup just opened on a still-valid link; reopening is fine.
										if (oauthIssue) void restartSignIn();
										else openSignIn(oauth.authUrl);
									}}
									disabled={oauthStart.isPending}
								>
									{oauthIssue ? "Restart ChatGPT sign-in" : "Open ChatGPT sign-in"}
									{oauthStart.isPending ? (
										<Spinner className="size-3.5" />
									) : (
										<ExternalLink className="size-3.5" />
									)}
								</Button>
								{oauthIssue === "expired" ? (
									<p className="flex items-center gap-2 text-xs text-destructive">
										<CircleAlert className="size-3.5" /> This sign-in link expired. Restart to get a
										fresh one.
									</p>
								) : oauthIssue === "blocked" ? (
									<p className="flex items-center gap-2 text-xs text-destructive">
										<CircleAlert className="size-3.5" /> Pop-up blocked. Allow pop-ups, then restart
										sign-in — or paste the address below.
									</p>
								) : oauthIssue === "closed" ? (
									<p className="flex items-center gap-2 text-xs text-muted-foreground">
										<CircleAlert className="size-3.5" /> The sign-in window closed before finishing.
										Restart it, or paste the address below.
									</p>
								) : oauthComplete.isPending ? (
									<p className="flex items-center gap-2 text-xs text-muted-foreground">
										<Spinner className="size-3.5" /> Connecting Codex…
									</p>
								) : (
									<p className="flex items-center gap-2 text-xs text-muted-foreground">
										<Spinner className="size-3.5" /> Waiting for sign-in to finish…
									</p>
								)}
								<details className="rounded-md border bg-muted/30 p-3 text-xs text-muted-foreground">
									<summary className="cursor-pointer font-medium text-foreground">
										Didn’t return automatically?
									</summary>
									<div className="mt-2 flex flex-col gap-2">
										<p>Paste the full address from the OpenAI page after signing in.</p>
										<Label htmlFor="provider-oauth-callback" className="sr-only">
											OAuth callback URL
										</Label>
										<Input
											id="provider-oauth-callback"
											name="provider-oauth-callback"
											value={oauthCode}
											onChange={(e) => setOauthCode(e.target.value)}
											placeholder="https://…/callback?code=…&state=…"
											autoComplete="off"
											spellCheck={false}
										/>
										<Button
											size="sm"
											onClick={submitPastedCallback}
											disabled={!oauthCode.trim() || oauthComplete.isPending}
										>
											{oauthComplete.isPending ? "Finishing…" : "Finish sign-in"}
										</Button>
										<p>
											If it never returns, an admin may need to register this app’s callback URL in
											the Codex OAuth config.
										</p>
									</div>
								</details>
							</div>
						</div>
						<DialogFooter className="shrink-0 border-t bg-background px-6 py-4">
							<Button variant="outline" onClick={() => requestClose(false)}>
								Cancel
							</Button>
						</DialogFooter>
					</>
				) : (
					<>
						<DialogHeader className="shrink-0 px-6 pt-6">
							<DialogTitle>{isEdit ? "Edit provider" : "Add a provider"}</DialogTitle>
							<DialogDescription>
								Route inference through your own account by API key, sign-in, or a custom endpoint.
							</DialogDescription>
						</DialogHeader>

						<div className="min-h-0 flex-1 overflow-y-auto px-6 py-4">
							<div className="flex flex-col gap-4">
								<div className="flex flex-col gap-1.5">
									<Label>Provider</Label>
									<div className="grid gap-2 sm:grid-cols-2">
										{PROVIDER_TYPES.map((t) => {
											const option = providerTypeMeta(t);
											return (
												<EntityChoiceCard
													key={t}
													selected={type === t}
													onClick={isEdit ? undefined : () => changeType(t)}
													disabled={isEdit}
													icon={
														<EntityIcon kind="provider" id={t} label={option.label} size="sm" />
													}
													title={option.label}
													description={providerTypeDescription(t)}
												/>
											);
										})}
									</div>
								</div>

								<div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3">
									<ProviderTypeChip type={type} />
									<div className="min-w-0 flex-1">
										<p className="text-sm font-medium text-foreground">{providerLabel}</p>
										<p className="text-xs text-muted-foreground">
											Saved as <code className="font-mono">{providerId || "—"}</code>
										</p>
										{catalogManaged ? (
											<>
												<p className="mt-1 text-xs text-muted-foreground">
													{authMethod === "oauth"
														? `ChatGPT/Codex mapping · ${catalogSummary || "No catalog models"}`
														: `Runtime mapping · ${API_MODE_LABEL[apiMode]} · ${catalogSummary || "No catalog models"}`}
												</p>
												<p className="mt-1 break-all font-mono text-xs text-muted-foreground">
													{baseUrl}
													{authMethod === "api_key" && runtimeEnvForSubmit
														? ` · ${runtimeEnvForSubmit}`
														: ""}
												</p>
											</>
										) : null}
									</div>
								</div>

								{showNameField ? (
									<div className="flex flex-col gap-1.5">
										<Label htmlFor="provider-label">Name</Label>
										<Input
											id="provider-label"
											name="provider-label"
											value={label}
											onChange={(e) => setLabel(e.target.value)}
											placeholder="Custom endpoint"
											autoComplete="off"
										/>
										<p className="text-xs text-muted-foreground">
											Optional. Used only to label this custom endpoint.
										</p>
									</div>
								) : null}

								{showAuthMethodField ? (
									<div className="flex flex-col gap-1.5">
										<Label htmlFor="provider-auth">Authentication</Label>
										<Select
											items={authMethodItems}
											value={authMethod}
											onValueChange={(value) => {
												if (isAuthMethod(value)) changeAuthMethod(value);
											}}
										>
											<SelectTrigger id="provider-auth">
												<SelectValue />
											</SelectTrigger>
											<SelectContent>
												<SelectItem value="api_key">API key</SelectItem>
												{meta.oauth ? (
													<SelectItem value="oauth">Sign in with ChatGPT (Codex)</SelectItem>
												) : null}
												{meta.custom ? <SelectItem value="none">No auth (local)</SelectItem> : null}
											</SelectContent>
										</Select>
									</div>
								) : null}

								{authMethod === "api_key" ? (
									<div className="flex flex-col gap-1.5">
										<Label htmlFor="provider-key">API key{apiKeyLabelSuffix}</Label>
										<Input
											id="provider-key"
											name="provider-key"
											type="password"
											value={apiKey}
											onChange={(e) => setApiKey(e.target.value)}
											placeholder="sk-…"
											autoComplete="off"
											spellCheck={false}
										/>
										<p className="text-xs text-muted-foreground">{apiKeyHelpText}</p>
										{keyRequired && isEdit && !apiKey.trim() ? (
											<p className="text-xs text-destructive">
												Enter a key to switch this provider to managed API-key auth.
											</p>
										) : null}
									</div>
								) : null}

								{showAdvancedFields ? (
									<div className="rounded-md border bg-muted/30 p-3">
										<div className="text-sm font-medium text-foreground">Advanced</div>
										<div className="mt-3 flex flex-col gap-3">
											<div className="flex flex-col gap-1.5">
												<Label htmlFor="provider-base">Base URL</Label>
												<Input
													id="provider-base"
													name="provider-base"
													value={baseUrl}
													onChange={(e) => setBaseUrl(e.target.value)}
													placeholder="https://api.example.com/v1"
													autoComplete="off"
													spellCheck={false}
												/>
												{authMethod === "none" && baseUrl.trim() && !noneAuthOk ? (
													<p className="text-xs text-destructive">
														No-auth providers must use a loopback or private-network URL (e.g.
														http://127.0.0.1:11434/v1).
													</p>
												) : null}
											</div>

											<div className="grid gap-3 sm:grid-cols-2">
												<div className="flex flex-col gap-1.5">
													<Label htmlFor="provider-mode">API mode</Label>
													<Select
														items={apiModeItems}
														value={apiMode}
														onValueChange={(value) => {
															if (isApiMode(value)) setApiMode(value);
														}}
													>
														<SelectTrigger id="provider-mode">
															<SelectValue />
														</SelectTrigger>
														<SelectContent>
															{meta.apiModes.map((m) => (
																<SelectItem key={m} value={m}>
																	{API_MODE_LABEL[m]}
																</SelectItem>
															))}
														</SelectContent>
													</Select>
												</div>

												{showRuntimeEnvField ? (
													<div className="flex flex-col gap-1.5">
														<Label htmlFor="provider-env">Runtime env var</Label>
														<Input
															id="provider-env"
															name="provider-env"
															value={runtimeEnv}
															onChange={(e) => setRuntimeEnv(e.target.value.toUpperCase())}
															placeholder="OPENAI_API_KEY"
															autoComplete="off"
															spellCheck={false}
														/>
													</div>
												) : null}
											</div>

											<div className="flex flex-col gap-1.5">
												<Label htmlFor="provider-models">Model catalog</Label>
												<Textarea
													id="provider-models"
													name="provider-models"
													value={modelsText}
													onChange={(e) => setModelsText(e.target.value)}
													placeholder={meta.modelPlaceholder}
													autoComplete="off"
													spellCheck={false}
													className="min-h-24 resize-y"
												/>
												<p className="text-xs text-muted-foreground">
													Optional. Enter one model id per line, or separate ids with commas.
												</p>
											</div>
										</div>
									</div>
								) : null}
							</div>
						</div>

						<DialogFooter className="shrink-0 border-t bg-background px-6 py-4">
							<Button variant="outline" onClick={() => requestClose(false)}>
								Cancel
							</Button>
							<Button onClick={submit} disabled={!canSubmit || busy}>
								{busy
									? "Saving…"
									: authMethod === "oauth"
										? "Continue to sign-in"
										: isEdit
											? "Save changes"
											: "Add provider"}
							</Button>
						</DialogFooter>
					</>
				)}
			</DialogContent>
		</Dialog>
	);
}
