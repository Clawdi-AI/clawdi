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
	useOAuthDevicePoll,
	useOAuthDeviceStart,
	usePatchProvider,
	useTestDraftProviderConnection,
} from "@/hosted/v2/ai-providers/ai-providers-hooks";
import { codexProviderBody } from "@/hosted/v2/ai-providers/codex-oauth";
import { type ProviderChoice, ProviderChooser } from "@/hosted/v2/ai-providers/provider-chooser";
import { ProviderFieldsForm } from "@/hosted/v2/ai-providers/provider-fields-form";
import { ProviderOAuthFlow } from "@/hosted/v2/ai-providers/provider-oauth-flow";
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
	AiProviderConnectionTestResponse,
	AiProviderPatch,
	AiProviderUpsert,
} from "@/hosted/v2/ai-providers/types";
import { useProviderForm } from "@/hosted/v2/ai-providers/use-provider-form";
import {
	type OAuthSession,
	useProviderOAuthDeviceFlow,
} from "@/hosted/v2/ai-providers/use-provider-oauth-device-flow";

type DialogStep = "choose" | "configure";

interface AcceptAttempt {
	fingerprint: string;
	secret: string;
	key: string;
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
	const testDraft = useTestDraftProviderConnection();
	const oauthDeviceStart = useOAuthDeviceStart();
	const oauthDevicePoll = useOAuthDevicePoll();
	const pollDeviceOAuth = oauthDevicePoll.execute;
	const runAction = useActionLock();
	const { state: form, reset: resetForm, update: updateForm } = useProviderForm();
	const isEdit = Boolean(editing);
	const isOAuthEdit =
		editing?.auth.type === "agent_profile" || editing?.auth.type === "oauth_profile";
	const [step, setStep] = useState<DialogStep>(editing ? "configure" : "choose");
	const [draftTestResult, setDraftTestResult] = useState<AiProviderConnectionTestResponse | null>(
		null,
	);
	const acceptAttemptRef = useRef<AcceptAttempt | null>(null);
	const {
		session: oauth,
		issue: oauthIssue,
		start: startOAuth,
		cancel: cancelOAuth,
		restart: restartOAuthFlow,
	} = useProviderOAuthDeviceFlow({
		poll: (session) =>
			pollDeviceOAuth({ providerId: session.providerId, state: session.state }).catch(() => null),
		onReady: (session) => {
			toast.success("Signed in with ChatGPT");
			if (session.mode === "accept") onCreated?.(session.providerId);
			onOpenChange(false);
		},
	});

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
	const canSubmit =
		providerListReady &&
		Boolean(providerId) &&
		Boolean(form.baseUrl.trim()) &&
		(isEdit || form.authMethod === "oauth" || Boolean(form.apiKey.trim()));

	useEffect(() => {
		if (!open) return;
		cancelOAuth();
		setDraftTestResult(null);
		acceptAttemptRef.current = null;

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
	}, [cancelOAuth, open, editing, resetForm]);

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
		setDraftTestResult(null);
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
		setDraftTestResult(null);
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

	async function acceptedOAuthSession({
		fresh = false,
	}: {
		fresh?: boolean;
	} = {}): Promise<OAuthSession | null> {
		const body = {
			provider: codexProviderBody(identity),
			credential: { type: "oauth", provider: "codex", flow: "device_code" },
			replace: false,
		} satisfies AiProviderAcceptRequest;
		const result = await acceptProvider
			.execute({
				body,
				idempotencyKey: acceptKey(body, "oauth", fresh),
			})
			.catch(() => null);
		if (!result) return null;
		if (result.status !== "pending") {
			toast.error("ChatGPT sign-in was already completed");
			return null;
		}
		if (result.authorization.flow !== "device_code") {
			toast.error("ChatGPT device sign-in is unavailable");
			return null;
		}
		return {
			mode: "accept",
			providerId: result.provider.provider_id,
			state: result.authorization.state,
			verificationUrl: result.authorization.verification_url,
			userCode: result.authorization.user_code,
			expiresAt: result.authorization.expires_at,
			pollIntervalSeconds: result.authorization.poll_interval_seconds,
		};
	}

	async function reconnectOAuthSession(): Promise<OAuthSession | null> {
		if (!editing) return null;
		const result = await oauthDeviceStart
			.execute({ providerId: editing.provider_id, provider: "codex" })
			.catch(() => null);
		if (!result) return null;
		return {
			mode: "reconnect",
			providerId: editing.provider_id,
			state: result.state,
			verificationUrl: result.verification_url,
			userCode: result.user_code,
			expiresAt: result.expires_at,
			pollIntervalSeconds: result.poll_interval_seconds,
		};
	}

	async function beginReconnectOAuth() {
		const session = await reconnectOAuthSession();
		if (session) startOAuth(session);
	}

	async function submit() {
		if (!canSubmit) return;
		if (editing) {
			const replacementKey = form.apiKey.trim();
			if (replacementKey) {
				const body = {
					provider: providerBody(),
					credential: { type: "api_key", value: replacementKey },
					replace: true,
				} satisfies AiProviderAcceptRequest;
				const result = await acceptProvider
					.execute({
						body,
						idempotencyKey: acceptKey(body, replacementKey),
					})
					.catch(() => null);
				if (result?.status !== "ready") return;
				updateForm({ apiKey: "" });
				toast.success("Provider updated");
				onOpenChange(false);
				return;
			}
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
			const session = await acceptedOAuthSession();
			if (session) startOAuth(session);
			return;
		}

		const body = {
			provider: providerBody(),
			credential: { type: "api_key", value: form.apiKey.trim() },
			replace: false,
		} satisfies AiProviderAcceptRequest;
		const result = await acceptProvider
			.execute({
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

	async function testDraftConnection() {
		const credential = form.apiKey.trim();
		if (!credential || form.authMethod !== "api_key") return;
		setDraftTestResult(null);
		const result = await testDraft
			.execute({
				provider: providerBody(),
				credential: { type: "api_key", value: credential },
				model: modelsFromText(form.modelsText, editing?.models, presetCatalog)?.[0]?.id ?? null,
			})
			.catch(() => null);
		if (!result) return;
		setDraftTestResult(result);
		if (result.ok) toast.success("Connection verified");
	}

	function requestClose(next: boolean) {
		if (!next) {
			cancelOAuth();
			updateForm({ apiKey: "" });
		}
		onOpenChange(next);
	}

	async function restartOAuth() {
		if (!oauth) return;
		await restartOAuthFlow(() =>
			oauth.mode === "accept" ? acceptedOAuthSession({ fresh: true }) : reconnectOAuthSession(),
		);
	}

	const busy =
		acceptProvider.isPending ||
		patchProvider.isPending ||
		testDraft.isPending ||
		oauthDeviceStart.isPending ||
		oauthDevicePoll.isPending;

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
								? (editing?.readiness?.deployable ?? editing?.usable) &&
									editing.auth.type !== "none"
									? "Edit provider"
									: "Finish provider setup"
								: step === "choose"
									? "Add a provider"
									: `Set up ${providerLabel}`}
					</DialogTitle>
					<DialogDescription>
						{oauth
							? "Open ChatGPT, enter the one-time code, and this page will finish automatically."
							: isOAuthEdit
								? "Your ChatGPT connection is ready. Reconnect only to change or repair the account."
								: isEdit
									? "Update settings and, if entered, the API key in one atomic save."
									: step === "choose"
										? "Choose a common provider or bring a custom endpoint."
										: "Only the credential is required. Provider details stay in Advanced."}
					</DialogDescription>
				</DialogHeader>

				<div className="min-h-0 flex-1 overflow-y-auto px-5 py-4 sm:px-6">
					{oauth ? (
						<ProviderOAuthFlow
							issue={oauthIssue}
							verificationUrl={oauth.verificationUrl}
							userCode={oauth.userCode}
							starting={acceptProvider.isPending || oauthDeviceStart.isPending}
							polling={oauthDevicePoll.isPending}
							onRestart={() => void runAction(restartOAuth)}
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
									setDraftTestResult(null);
									updateForm(value);
								}}
								onAuthMethodChange={changeAuthMethod}
								onRegionChange={changeRegion}
								onReconnectOAuth={() => void runAction(beginReconnectOAuth)}
								startingOAuth={oauthDeviceStart.isPending}
							/>
							{draftTestResult ? (
								<div
									aria-live="polite"
									className={
										draftTestResult.ok
											? "rounded-md border border-success/30 bg-success-muted p-3 text-xs text-success"
											: "rounded-md border border-warning/30 bg-warning-muted p-3 text-xs text-warning-muted-foreground"
									}
								>
									{draftTestResult.ok
										? "Credential, endpoint, protocol, and model verified."
										: (draftTestResult.error?.message ?? "Connection test failed.")}
								</div>
							) : null}
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
					) : isOAuthEdit ? (
						<Button variant="outline" onClick={() => requestClose(false)} disabled={busy}>
							Close
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
							{form.authMethod === "api_key" ? (
								<Button
									variant="outline"
									onClick={() => void runAction(testDraftConnection)}
									disabled={!form.apiKey.trim() || busy}
								>
									{testDraft.isPending ? <Spinner data-icon="inline-start" /> : null}
									Test connection
								</Button>
							) : null}
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
