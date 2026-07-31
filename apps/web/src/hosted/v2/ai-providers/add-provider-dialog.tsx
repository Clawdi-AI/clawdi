"use client";

import { ArrowLeft, CircleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { newIdempotencyKey } from "@/hosted/billing/idempotency";
import { useActionLock } from "@/hosted/billing/use-action-lock";
import {
	type AuthMethod,
	authFor,
	derivedProviderFields,
	modelsFromText,
	modelsToText,
	providerFormIdentity,
	providerListAllowsSubmit,
} from "@/hosted/v2/ai-providers/add-provider-dialog.logic";
import {
	useAcceptProvider,
	useAiProviders,
	useCompleteProviderAccept,
	useOAuthComplete,
	useOAuthStart,
	usePatchProvider,
	useSetApiKey,
} from "@/hosted/v2/ai-providers/ai-providers-hooks";
import {
	CLAWDI_CODEX_OAUTH_PROVIDER_ID,
	CODEX_OAUTH_CHANNEL,
	type CodexOAuthResult,
	codexOAuthStateMatches,
	codexProviderBody,
	codexRedirectUri,
	parseCodexCallback,
} from "@/hosted/v2/ai-providers/codex-oauth";
import { type ProviderChoice, ProviderChooser } from "@/hosted/v2/ai-providers/provider-chooser";
import { ProviderFieldsForm } from "@/hosted/v2/ai-providers/provider-fields-form";
import { type OAuthIssue, ProviderOAuthFlow } from "@/hosted/v2/ai-providers/provider-oauth-flow";
import {
	presetCatalogToProviderModels,
	providerPresetById,
	providerPresetForSavedProvider,
	providerPresetRegion,
	providerTypeForPreset,
} from "@/hosted/v2/ai-providers/provider-presets";
import { providerTypeMeta } from "@/hosted/v2/ai-providers/provider-types";
import type {
	AiProvider,
	AiProviderAcceptRequest,
	AiProviderPatch,
	AiProviderUpsert,
} from "@/hosted/v2/ai-providers/types";
import { useProviderForm } from "@/hosted/v2/ai-providers/use-provider-form";

type DialogStep = "choose" | "configure";
type OAuthMode = "accept" | "legacy";

interface OAuthSession {
	mode: OAuthMode;
	providerId: string;
	state: string;
	authUrl: string;
	redirectUri: string;
	expiresAt: string;
}

interface AcceptAttempt {
	fingerprint: string;
	secret: string;
	key: string;
}

function readOAuthResult(value: unknown): CodexOAuthResult | null {
	if (!value || typeof value !== "object") return null;
	const result = value as Record<string, unknown>;
	if (typeof result.code !== "string" || typeof result.state !== "string") return null;
	if (result.error !== undefined && typeof result.error !== "string") return null;
	return {
		code: result.code,
		state: result.state,
		...(typeof result.error === "string" ? { error: result.error } : {}),
	};
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
	const acceptProvider = useAcceptProvider();
	const patchProvider = usePatchProvider();
	const setKey = useSetApiKey();
	const oauthStart = useOAuthStart();
	const oauthComplete = useOAuthComplete();
	const completeAccept = useCompleteProviderAccept();
	const runAction = useActionLock();
	const { state: form, reset: resetForm, update: updateForm } = useProviderForm();
	const isEdit = Boolean(editing);
	const [step, setStep] = useState<DialogStep>(editing ? "configure" : "choose");
	const [oauth, setOauth] = useState<OAuthSession | null>(null);
	const [oauthCode, setOauthCode] = useState("");
	const [oauthIssue, setOauthIssue] = useState<OAuthIssue | null>(null);
	const popupRef = useRef<Window | null>(null);
	const completedRef = useRef(false);
	const finishRef = useRef<(result: CodexOAuthResult) => void>(() => {});
	const acceptAttemptRef = useRef<AcceptAttempt | null>(null);
	const completionAttemptRef = useRef<AcceptAttempt | null>(null);

	const selectedPreset = providerPresetById(form.presetId);
	const selectedRegion = selectedPreset
		? providerPresetRegion(selectedPreset, form.regionId)
		: null;
	const meta = providerTypeMeta(form.type);
	const existingProviderIds = providers.data?.providers.map((item) => item.provider_id) ?? [];
	const identity = providerFormIdentity({
		type: form.type,
		authMethod: form.authMethod,
		labelInput: form.label,
		existingProviderIds,
		editing,
		preset: selectedPreset,
	});
	const providerId = identity.providerId;
	const providerLabel = identity.label ?? (providerId || meta.label);
	const runtimeEnv = form.runtimeEnv.trim() || meta.defaultRuntimeEnv;
	const presetCatalog = selectedPreset ? presetCatalogToProviderModels(selectedPreset) : [];
	const providerListReady = providerListAllowsSubmit(isEdit, providers.isSuccess);
	const oauthAlreadyConnected =
		!isEdit &&
		form.authMethod === "oauth" &&
		providers.data?.providers.some(
			(item) => item.provider_id === CLAWDI_CODEX_OAUTH_PROVIDER_ID && item.usable,
		) === true;
	const canSubmit =
		providerListReady &&
		Boolean(providerId) &&
		Boolean(form.baseUrl.trim()) &&
		(isEdit || form.authMethod === "oauth" || Boolean(form.apiKey.trim())) &&
		!oauthAlreadyConnected;

	useEffect(() => {
		if (!open) return;
		setOauth(null);
		setOauthCode("");
		setOauthIssue(null);
		popupRef.current = null;
		completedRef.current = false;
		acceptAttemptRef.current = null;
		completionAttemptRef.current = null;

		if (editing) {
			const type = editing.type;
			const authMethod: AuthMethod =
				editing.auth.type === "agent_profile" || editing.auth.type === "oauth_profile"
					? "oauth"
					: "api_key";
			const preset = providerPresetForSavedProvider({
				providerId: editing.provider_id,
				baseUrl: editing.base_url,
			});
			const defaults = derivedProviderFields(type, authMethod, preset);
			const region = preset?.region_variants?.find(
				(item) => item.base_url.replace(/\/+$/, "") === editing.base_url.replace(/\/+$/, ""),
			);
			resetForm({
				type,
				label: editing.label ?? "",
				baseUrl: editing.base_url || defaults.baseUrl,
				modelsText:
					(editing.models?.length ?? 0) > 0 ? modelsToText(editing.models) : defaults.modelsText,
				apiMode: editing.api_mode ?? defaults.apiMode,
				runtimeEnv: editing.runtime_env_name ?? defaults.runtimeEnv,
				authMethod,
				apiKey: "",
				presetId: preset?.id ?? null,
				regionId: region?.id ?? preset?.region_variants?.[0]?.id ?? null,
			});
			setStep("configure");
			return;
		}

		const defaults = derivedProviderFields("openai", "api_key");
		resetForm({
			type: "openai",
			label: "",
			baseUrl: defaults.baseUrl,
			modelsText: defaults.modelsText,
			apiMode: defaults.apiMode,
			runtimeEnv: defaults.runtimeEnv,
			authMethod: "api_key",
			apiKey: "",
			presetId: null,
			regionId: null,
		});
		setStep("choose");
	}, [open, editing, resetForm]);

	function selectProvider(choice: ProviderChoice) {
		acceptAttemptRef.current = null;
		if (choice.kind === "preset") {
			const type = providerTypeForPreset(choice.preset);
			const defaults = derivedProviderFields(type, "api_key", choice.preset);
			const region = providerPresetRegion(choice.preset, null);
			resetForm({
				type,
				label: "",
				baseUrl: region?.base_url ?? defaults.baseUrl,
				modelsText: defaults.modelsText,
				apiMode: defaults.apiMode,
				runtimeEnv: defaults.runtimeEnv,
				authMethod: "api_key",
				apiKey: "",
				presetId: choice.preset.id,
				regionId: region?.id ?? null,
			});
		} else {
			const defaults = derivedProviderFields(choice.type, "api_key");
			resetForm({
				type: choice.type,
				label: "",
				baseUrl: defaults.baseUrl,
				modelsText: defaults.modelsText,
				apiMode: defaults.apiMode,
				runtimeEnv: defaults.runtimeEnv,
				authMethod: "api_key",
				apiKey: "",
				presetId: null,
				regionId: null,
			});
		}
		setStep("configure");
	}

	function changeAuthMethod(authMethod: AuthMethod) {
		const defaults = derivedProviderFields(form.type, authMethod, selectedPreset);
		acceptAttemptRef.current = null;
		updateForm({
			authMethod,
			apiKey: "",
			baseUrl: defaults.baseUrl,
			modelsText: defaults.modelsText,
			apiMode: defaults.apiMode,
			runtimeEnv: defaults.runtimeEnv,
		});
	}

	function changeRegion(regionId: string) {
		if (!selectedPreset) return;
		const region = providerPresetRegion(selectedPreset, regionId);
		if (!region) return;
		acceptAttemptRef.current = null;
		updateForm({ regionId: region.id, baseUrl: region.base_url });
	}

	function providerBody(): AiProviderUpsert {
		return {
			provider_id: providerId,
			type: form.type,
			label: identity.label,
			base_url: form.baseUrl.trim(),
			models: modelsFromText(form.modelsText, editing?.models, presetCatalog),
			api_mode: form.apiMode,
			auth: authFor(form.authMethod),
			managed_by: "user",
			runtime_env_name: form.authMethod === "api_key" ? runtimeEnv : null,
		};
	}

	function acceptKey(body: AiProviderAcceptRequest, secret: string, fresh = false): string {
		const fingerprint = JSON.stringify({
			provider: body.provider,
			credential: body.credential.type,
		});
		const current = acceptAttemptRef.current;
		if (!fresh && current?.fingerprint === fingerprint && current.secret === secret)
			return current.key;
		const attempt = {
			fingerprint,
			secret,
			key: newIdempotencyKey("ai-provider-accept"),
		};
		acceptAttemptRef.current = attempt;
		return attempt.key;
	}

	function preparePopup(): Window | null {
		setOauthIssue(null);
		const popup = window.open("about:blank", "codex-oauth", "popup,width=520,height=720");
		popupRef.current = popup;
		if (!popup) {
			setOauthIssue("blocked");
			return null;
		}
		try {
			popup.document.title = "Opening ChatGPT";
			popup.document.body.textContent = "Opening ChatGPT sign-in…";
			popup.document.body.style.cssText =
				"font-family:system-ui,sans-serif;padding:24px;color:#555";
		} catch {
			// A browser may deny access even before navigation. The handle is still usable.
		}
		return popup;
	}

	function navigatePopup(popup: Window, url: string): boolean {
		try {
			if (popup.closed) {
				setOauthIssue("closed");
				return false;
			}
			popup.location.replace(url);
			popup.focus();
			return true;
		} catch {
			setOauthIssue("closed");
			return false;
		}
	}

	async function beginAcceptedOAuth({ fresh = false }: { fresh?: boolean } = {}) {
		const popup = preparePopup();
		if (!popup) return;
		const redirectUri = codexRedirectUri();
		const body = {
			provider: codexProviderBody(),
			credential: { type: "oauth", provider: "codex", redirect_uri: redirectUri },
		} satisfies AiProviderAcceptRequest;
		const result = await acceptProvider
			.mutateAsync({
				body,
				idempotencyKey: acceptKey(body, "oauth", fresh),
			})
			.catch(() => null);
		if (!result) {
			popup.close();
			return;
		}
		if (result.status !== "pending") {
			popup.close();
			toast.error("ChatGPT sign-in was already completed");
			return;
		}
		completedRef.current = false;
		setOauthIssue(null);
		setOauthCode("");
		setOauth({
			mode: "accept",
			providerId: result.provider.provider_id,
			state: result.authorization.state,
			authUrl: result.authorization.auth_url,
			redirectUri: result.authorization.redirect_uri,
			expiresAt: result.authorization.expires_at,
		});
		navigatePopup(popup, result.authorization.auth_url);
	}

	async function beginLegacyOAuth() {
		if (!editing) return;
		const popup = preparePopup();
		if (!popup) return;
		const redirectUri = codexRedirectUri();
		const result = await oauthStart
			.execute({ providerId: editing.provider_id, provider: "codex", redirect_uri: redirectUri })
			.catch(() => null);
		if (!result) {
			popup.close();
			return;
		}
		completedRef.current = false;
		setOauthIssue(null);
		setOauthCode("");
		setOauth({
			mode: "legacy",
			providerId: editing.provider_id,
			state: result.state,
			authUrl: result.auth_url,
			redirectUri,
			expiresAt: result.expires_at,
		});
		navigatePopup(popup, result.auth_url);
	}

	async function submit() {
		if (!canSubmit) return;
		if (editing) {
			const patch = {
				type: form.type,
				label: identity.label,
				base_url: form.baseUrl.trim(),
				api_mode: form.apiMode,
				managed_by: "user",
				runtime_env_name:
					editing.auth.type === "agent_profile" || editing.auth.type === "oauth_profile"
						? editing.runtime_env_name
						: runtimeEnv,
				models: modelsFromText(form.modelsText, editing.models, presetCatalog),
			} satisfies AiProviderPatch;
			const saved = await patchProvider
				.mutateAsync({ providerId: editing.provider_id, body: patch })
				.catch(() => null);
			if (!saved) return;
			toast.success("Provider settings updated");
			onOpenChange(false);
			return;
		}

		if (form.authMethod === "oauth") {
			await beginAcceptedOAuth();
			return;
		}

		const body = {
			provider: providerBody(),
			credential: { type: "api_key", value: form.apiKey.trim() },
		} satisfies AiProviderAcceptRequest;
		const result = await acceptProvider
			.mutateAsync({
				body,
				idempotencyKey: acceptKey(body, form.apiKey.trim()),
			})
			.catch(() => null);
		if (result?.status !== "ready") return;
		toast.success("Provider added");
		updateForm({ apiKey: "" });
		onCreated?.(result.provider.provider_id);
		onOpenChange(false);
	}

	async function replaceApiKey() {
		if (!editing || !form.apiKey.trim() || setKey.isPending) return;
		const result = await setKey
			.execute({
				providerId: editing.provider_id,
				value: form.apiKey.trim(),
				runtime_env_name: runtimeEnv,
			})
			.catch(() => null);
		if (!result) return;
		updateForm({ apiKey: "" });
		toast.success(
			editing.usable && editing.auth.type !== "none" ? "API key replaced" : "API key saved",
		);
	}

	function closePopup() {
		try {
			if (popupRef.current && !popupRef.current.closed) popupRef.current.close();
		} catch {
			// Ignore a cross-origin close failure.
		}
		popupRef.current = null;
	}

	function requestClose(next: boolean) {
		if (!next) {
			completedRef.current = true;
			closePopup();
			setOauth(null);
			setOauthCode("");
			updateForm({ apiKey: "" });
		}
		onOpenChange(next);
	}

	async function restartOAuth() {
		if (!oauth) return;
		if (oauth.mode === "accept") await beginAcceptedOAuth({ fresh: true });
		else await beginLegacyOAuth();
	}

	function submitPastedCallback() {
		const parsed = parseCodexCallback(oauthCode);
		if (!parsed) {
			toast.error("Couldn't read that callback address");
			return;
		}
		finishRef.current(parsed);
	}

	finishRef.current = async (result: CodexOAuthResult) => {
		if (!oauth || completedRef.current) return;
		if (result.error || !result.code) {
			toast.error("ChatGPT sign-in failed", {
				description: "Restart sign-in and try again.",
			});
			return;
		}
		if (!codexOAuthStateMatches(oauth.state, result)) {
			toast.error("ChatGPT sign-in could not be verified", {
				description: "The state did not match. Restart sign-in and try again.",
			});
			return;
		}
		completedRef.current = true;
		const completionFingerprint = `${oauth.mode}:${oauth.providerId}:${result.state}:${result.code}`;
		const currentCompletion = completionAttemptRef.current;
		const completionKey =
			currentCompletion?.fingerprint === completionFingerprint
				? currentCompletion.key
				: newIdempotencyKey("ai-provider-oauth-complete");
		completionAttemptRef.current = {
			fingerprint: completionFingerprint,
			secret: result.code,
			key: completionKey,
		};
		const done =
			oauth.mode === "accept"
				? await completeAccept
						.execute({
							providerId: oauth.providerId,
							state: result.state,
							code: result.code,
							redirect_uri: oauth.redirectUri,
							idempotencyKey: completionKey,
						})
						.catch(() => null)
				: await oauthComplete
						.execute({
							providerId: oauth.providerId,
							state: result.state,
							code: result.code,
							redirect_uri: oauth.redirectUri,
						})
						.catch(() => null);
		if (!done) {
			completedRef.current = false;
			return;
		}
		toast.success("Signed in with ChatGPT");
		closePopup();
		setOauth(null);
		setOauthCode("");
		if (!isEdit) onCreated?.(oauth.providerId);
		onOpenChange(false);
	};

	useEffect(() => {
		if (!oauth) return;
		const handle = (value: unknown) => {
			const result = readOAuthResult(value);
			if (result) finishRef.current(result);
		};
		let channel: BroadcastChannel | null = null;
		try {
			channel = new BroadcastChannel(CODEX_OAUTH_CHANNEL);
			channel.onmessage = (event) => handle(event.data);
		} catch {
			// postMessage and manual paste remain available.
		}
		const onMessage = (event: MessageEvent) => {
			if (
				event.origin === window.location.origin &&
				event.source === popupRef.current &&
				(event.data as { source?: unknown } | null)?.source === CODEX_OAUTH_CHANNEL
			) {
				handle(event.data);
			}
		};
		window.addEventListener("message", onMessage);
		return () => {
			channel?.close();
			window.removeEventListener("message", onMessage);
		};
	}, [oauth]);

	useEffect(() => {
		if (!oauth) return;
		const poll = setInterval(() => {
			if (!completedRef.current && popupRef.current?.closed) {
				setOauthIssue((current) => current ?? "closed");
			}
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
		acceptProvider.isPending ||
		patchProvider.isPending ||
		setKey.isPending ||
		oauthStart.isPending ||
		oauthComplete.isPending ||
		completeAccept.isPending;

	return (
		<Dialog open={open} onOpenChange={requestClose}>
			<DialogContent
				data-hosted="true"
				data-v2="true"
				className="flex max-h-[min(92vh,calc(100dvh-1rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl"
			>
				<DialogHeader className="shrink-0 px-5 pt-5 sm:px-6 sm:pt-6">
					<DialogTitle>
						{oauth
							? "Sign in with ChatGPT"
							: isEdit
								? editing?.usable && editing.auth.type !== "none"
									? "Edit provider"
									: "Finish provider setup"
								: step === "choose"
									? "Add a provider"
									: `Set up ${providerLabel}`}
					</DialogTitle>
					<DialogDescription>
						{oauth
							? "Finish in the ChatGPT window. This page will continue automatically."
							: isEdit
								? "Edit this provider directly. Credential replacement is saved separately."
								: step === "choose"
									? "Choose a common provider or bring a custom endpoint."
									: "Only the credential is required. Provider details stay in Advanced."}
					</DialogDescription>
				</DialogHeader>

				<div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">
					{oauth ? (
						<ProviderOAuthFlow
							issue={oauthIssue}
							callbackUrl={oauthCode}
							starting={acceptProvider.isPending || oauthStart.isPending}
							completing={oauthComplete.isPending || completeAccept.isPending}
							onCallbackUrlChange={setOauthCode}
							onRestart={() => void runAction(restartOAuth)}
							onFinish={() => void runAction(submitPastedCallback)}
						/>
					) : step === "choose" && !isEdit ? (
						<ProviderChooser onSelect={selectProvider} />
					) : (
						<div className="flex flex-col gap-3">
							{!providerListReady ? (
								<div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
									<CircleAlert className="mt-0.5 size-3.5 shrink-0" />
									{providers.isLoading
										? "Providers are still loading."
										: "Providers couldn't be loaded. Refresh and try again."}
								</div>
							) : null}
							{oauthAlreadyConnected ? (
								<div className="flex items-start gap-2 rounded-md border border-warning/30 bg-warning-muted p-3 text-xs text-warning-muted-foreground">
									<CircleAlert className="mt-0.5 size-3.5 shrink-0" /> ChatGPT is already connected.
									Edit the existing provider to reconnect it.
								</div>
							) : null}
							{oauthIssue === "blocked" ? (
								<div className="flex items-start gap-2 rounded-md border border-destructive/30 bg-destructive/5 p-3 text-xs text-destructive">
									<CircleAlert className="mt-0.5 size-3.5 shrink-0" /> Your browser blocked the
									ChatGPT window. Allow pop-ups, then try again.
								</div>
							) : null}
							<ProviderFieldsForm
								form={form}
								editing={editing ?? null}
								preset={selectedPreset}
								region={selectedRegion}
								providerId={providerId}
								providerLabel={providerLabel}
								apiKeyUrl={selectedRegion?.api_key_url ?? selectedPreset?.api_key_url ?? null}
								onUpdate={(value) => {
									acceptAttemptRef.current = null;
									updateForm(value);
								}}
								onAuthMethodChange={changeAuthMethod}
								onRegionChange={changeRegion}
								onReplaceApiKey={() => void runAction(replaceApiKey)}
								onReconnectOAuth={() => void runAction(beginLegacyOAuth)}
								replacingApiKey={setKey.isPending}
								startingOAuth={oauthStart.isPending}
							/>
						</div>
					)}
				</div>

				<DialogFooter className="shrink-0 border-t bg-background px-5 py-3 sm:px-6 sm:py-4">
					{oauth ? (
						<Button variant="outline" onClick={() => requestClose(false)} disabled={busy}>
							Cancel
						</Button>
					) : step === "choose" && !isEdit ? (
						<Button variant="outline" onClick={() => requestClose(false)}>
							Cancel
						</Button>
					) : (
						<>
							<Button
								variant="outline"
								onClick={() => {
									if (isEdit) requestClose(false);
									else setStep("choose");
								}}
								disabled={busy}
							>
								{isEdit ? null : <ArrowLeft />}
								{isEdit ? "Cancel" : "Back"}
							</Button>
							<Button onClick={() => void runAction(submit)} disabled={!canSubmit || busy}>
								{busy ? <Spinner data-icon="inline-start" /> : null}
								{form.authMethod === "oauth" && !isEdit
									? busy
										? "Opening sign-in…"
										: "Continue to ChatGPT"
									: isEdit
										? busy
											? "Saving settings…"
											: "Save settings"
										: busy
											? "Adding provider…"
											: "Add provider"}
							</Button>
						</>
					)}
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
