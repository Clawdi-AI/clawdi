"use client";

import { nativeAiProvider } from "@clawdi/shared";

import { ArrowLeft, CircleAlert } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { EntityIcon } from "@/components/entity-icon";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { useDialogExitLifecycle } from "@/components/ui/use-dialog-exit-lifecycle";
import { newIdempotencyKey } from "@/hosted/billing/idempotency";
import { useActionLock } from "@/hosted/billing/use-action-lock";
import {
	type AuthMethod,
	authFor,
	connectionProviderPatch,
	customProviderRuntimeEnv,
	derivedProviderFields,
	providerFormIdentity,
	providerListAllowsSubmit,
	providerSettingsPatch,
} from "@/hosted/v2/ai-providers/add-provider-dialog.logic";
import {
	useAcceptProvider,
	useAiProviders,
	useOAuthDevicePoll,
	useOAuthDeviceStart,
	usePatchProvider,
	useUpdateConnectionProvider,
} from "@/hosted/v2/ai-providers/ai-providers-hooks";
import { codexProviderBody } from "@/hosted/v2/ai-providers/codex-oauth";
import { type ProviderChoice, ProviderChooser } from "@/hosted/v2/ai-providers/provider-chooser";
import { ProviderFieldsForm } from "@/hosted/v2/ai-providers/provider-fields-form";
import { ProviderOAuthFlow } from "@/hosted/v2/ai-providers/provider-oauth-flow";
import {
	providerPresetById,
	providerPresetForSavedProvider,
	providerPresetRegion,
} from "@/hosted/v2/ai-providers/provider-presets";
import { providerTypeMeta } from "@/hosted/v2/ai-providers/provider-types";
import type {
	AiProvider,
	AiProviderAcceptRequest,
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
	const updateConnection = useUpdateConnectionProvider();
	const oauthDeviceStart = useOAuthDeviceStart();
	const oauthDevicePoll = useOAuthDevicePoll();
	const pollDeviceOAuth = oauthDevicePoll.execute;
	const runAction = useActionLock();
	const { state: form, reset: resetForm, update: updateForm } = useProviderForm();
	const isEdit = Boolean(editing);
	const [step, setStep] = useState<DialogStep>(editing ? "configure" : "choose");
	const acceptAttemptRef = useRef<AcceptAttempt | null>(null);
	const {
		session: oauth,
		issue: oauthIssue,
		invalidate: invalidateOAuth,
		clear: clearOAuth,
		transition: transitionOAuth,
	} = useProviderOAuthDeviceFlow({
		poll: (session) =>
			pollDeviceOAuth({ providerId: session.providerId, state: session.state }).catch(() => null),
		onReady: (session) => {
			toast.success("Signed in with ChatGPT");
			if (session.mode === "accept") onCreated?.(session.providerId);
			requestClose(false);
		},
	});
	const oauthExit = useDialogExitLifecycle({
		open,
		value: { session: oauth, issue: oauthIssue },
		emptyValue: { session: null, issue: null },
	});
	const renderedOAuth = oauthExit.renderedValue.session;
	const renderedOAuthIssue = oauthExit.renderedValue.issue;

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
	const runtimeEnv = editing
		? (editing.runtime_env_name ?? meta.defaultRuntimeEnv)
		: meta.custom
			? customProviderRuntimeEnv(providerId, providers.data?.providers ?? [])
			: meta.defaultRuntimeEnv;
	const nativeRoute = nativeAiProvider(
		form.authMethod === "oauth" ? "openai-codex" : (selectedPreset?.id ?? form.type),
		form.regionId,
	);
	const nativeConnection = form.configurationMode === "native" && nativeRoute !== undefined;
	const showCustomRouting =
		form.configurationMode === "custom" ||
		(form.configurationMode === "connection" && !nativeRoute) ||
		(!nativeConnection &&
			(!nativeRoute ||
				form.baseUrl !== nativeRoute.base_url ||
				form.apiMode !== nativeRoute.api_mode));
	const providerListReady = providerListAllowsSubmit(isEdit, providers.data !== undefined);
	const savedCredentialAvailable = editing != null && editing.auth.type !== "none";
	const customNameProvided =
		meta.custom !== true || selectedPreset !== null || Boolean(form.label.trim());
	const canSubmit =
		providerListReady &&
		(form.configurationMode !== "native" || nativeRoute !== undefined) &&
		Boolean(providerId) &&
		customNameProvided &&
		Boolean(form.baseUrl.trim()) &&
		(form.authMethod === "oauth" || savedCredentialAvailable || Boolean(form.apiKey.trim()));

	useEffect(() => {
		if (!open) return;
		oauthExit.beginOpen();
		invalidateOAuth();
		clearOAuth();

		acceptAttemptRef.current = null;

		if (editing) {
			const type = editing.type;
			const authMethod: AuthMethod =
				editing.auth.type === "agent_profile" || editing.auth.type === "oauth_profile"
					? "oauth"
					: "api_key";
			const preset =
				providerPresetById(editing.native_provider) ??
				providerPresetForSavedProvider({
					baseUrl: editing.base_url,
				});
			const defaults = derivedProviderFields(type, authMethod, preset);
			const region = preset?.region_variants?.find(
				(item) => item.base_url.replace(/\/+$/, "") === editing.base_url.replace(/\/+$/, ""),
			);
			resetForm({
				configurationMode: editing.configuration_mode ?? "catalog",
				type,
				label: editing.label ?? "",
				baseUrl: editing.base_url || defaults.baseUrl,

				apiMode: editing.api_mode ?? defaults.apiMode,

				authMethod,
				apiKey: "",
				presetId: preset?.id ?? null,
				regionId: editing.native_variant ?? region?.id ?? preset?.region_variants?.[0]?.id ?? null,
			});
			setStep("configure");
			return;
		}

		const defaults = derivedProviderFields("openai", "api_key");
		resetForm({
			configurationMode: "native",
			type: "openai",
			label: "",
			baseUrl: defaults.baseUrl,

			apiMode: defaults.apiMode,

			authMethod: "api_key",
			apiKey: "",
			presetId: null,
			regionId: null,
		});
		setStep("choose");
	}, [clearOAuth, editing, invalidateOAuth, oauthExit.beginOpen, open, resetForm]);

	function selectProvider(choice: ProviderChoice) {
		acceptAttemptRef.current = null;
		if (choice.kind === "oauth") {
			const defaults = derivedProviderFields("openai", "oauth");
			resetForm({
				configurationMode: "native",
				type: "openai",
				label: "",
				baseUrl: defaults.baseUrl,
				apiMode: defaults.apiMode,
				authMethod: "oauth",
				apiKey: "",
				presetId: null,
				regionId: null,
			});
		} else if (choice.kind === "preset") {
			const type = choice.preset.provider_type;
			const defaults = derivedProviderFields(type, "api_key", choice.preset);
			const region = providerPresetRegion(choice.preset, choice.regionId ?? null);
			resetForm({
				configurationMode: "native",
				type,
				label: region ? `${choice.preset.label} · ${region.label}` : "",
				baseUrl: region?.base_url ?? defaults.baseUrl,

				apiMode: defaults.apiMode,

				authMethod: "api_key",
				apiKey: "",
				presetId: choice.preset.id,
				regionId: region?.id ?? null,
			});
		} else {
			const defaults = derivedProviderFields(choice.type, "api_key");
			resetForm({
				configurationMode: choice.type === "custom_openai_compatible" ? "custom" : "native",
				type: choice.type,
				label: "",
				baseUrl: defaults.baseUrl,

				apiMode: defaults.apiMode,

				authMethod: "api_key",
				apiKey: "",
				presetId: null,
				regionId: null,
			});
		}
		setStep("configure");
	}

	function providerBody(): AiProviderUpsert {
		return {
			provider_id: providerId,
			type: nativeConnection ? nativeRoute.type : form.type,
			label: identity.label,
			configuration_mode: form.configurationMode,
			native_provider: nativeConnection ? nativeRoute.id : null,
			native_variant: nativeConnection ? nativeRoute.variant : null,
			base_url: nativeConnection ? nativeRoute.base_url : form.baseUrl.trim(),
			...(nativeConnection
				? {}
				: editing
					? { models: editing.models, capabilities: editing.capabilities }
					: {}),
			api_mode: nativeConnection ? nativeRoute.api_mode : form.apiMode,
			auth: authFor(form.authMethod),
			managed_by: "user",
			runtime_env_name:
				form.authMethod === "api_key"
					? nativeConnection
						? nativeRoute.runtime_env_name
						: runtimeEnv
					: null,
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
		await transitionOAuth(reconnectOAuthSession);
	}

	async function submit() {
		if (!canSubmit) return;
		if (editing) {
			const replacementKey = form.apiKey.trim();
			if (editing.configuration_mode === "connection" || editing.configuration_mode === "custom") {
				const saved = await updateConnection
					.execute({
						providerId: editing.provider_id,
						body: connectionProviderPatch(editing, {
							label: identity.label,
							baseUrl: form.baseUrl,
							apiMode: form.apiMode,
							apiKey: replacementKey,
						}),
					})
					.catch(() => null);
				if (!saved) return;
				toast.success("Provider updated");
				requestClose(false);
				return;
			}
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
				toast.success("Provider updated");

				requestClose(false);
				return;
			}
			const update = providerSettingsPatch(editing, providerBody());
			const saved = await patchProvider
				.mutateAsync({
					params: { path: { provider_id: editing.provider_id } },
					body: update,
				})
				.catch(() => null);
			if (!saved) return;
			toast.success("Provider settings updated");

			requestClose(false);
			return;
		}

		if (form.authMethod === "oauth") {
			await transitionOAuth(acceptedOAuthSession);
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

		onCreated?.(result.provider.provider_id);
		requestClose(false);
	}

	function requestClose(next: boolean) {
		if (!next) {
			oauthExit.beginClose();
			invalidateOAuth();
		}
		onOpenChange(next);
	}

	function completeOpenChange(next: boolean) {
		if (next) return;
		clearOAuth();
		oauthExit.completeClose();
		updateForm({ apiKey: "" });

		acceptAttemptRef.current = null;
	}

	async function restartOAuth() {
		if (!oauth) return;
		await transitionOAuth(() =>
			oauth.mode === "accept" ? acceptedOAuthSession({ fresh: true }) : reconnectOAuthSession(),
		);
	}

	const busy =
		acceptProvider.isPending ||
		patchProvider.isPending ||
		updateConnection.isPending ||
		oauthDeviceStart.isPending ||
		oauthDevicePoll.isPending;

	return (
		<Dialog open={open} onOpenChange={requestClose} onOpenChangeComplete={completeOpenChange}>
			<DialogContent
				data-hosted="true"
				data-v2="true"
				className="flex max-h-[min(36rem,calc(100dvh-2rem))] flex-col gap-0 overflow-hidden p-0 sm:max-w-xl"
			>
				<DialogHeader className="shrink-0 px-5 pt-5 pr-14 sm:px-6 sm:pt-6 sm:pr-14">
					<DialogTitle className="flex min-w-0 items-center gap-3">
						{step === "configure" || isEdit || renderedOAuth ? (
							<span aria-hidden="true" className="shrink-0">
								<EntityIcon
									kind="provider"
									id={
										renderedOAuth || form.authMethod === "oauth"
											? "openai"
											: (selectedPreset?.id ?? form.type)
									}
									label={providerLabel}
									size="md"
								/>
							</span>
						) : null}
						<span className="min-w-0 break-words">
							{renderedOAuth
								? "Sign in with ChatGPT"
								: isEdit
									? (editing?.readiness?.deployable ?? editing?.usable) &&
										editing.auth.type !== "none"
										? `Edit ${providerLabel}`
										: `Finish ${providerLabel} setup`
									: step === "choose"
										? "Add a provider"
										: `Set up ${providerLabel}`}
						</span>
					</DialogTitle>
				</DialogHeader>

				<div
					data-testid="provider-dialog-body"
					className="min-h-0 flex-1 overflow-y-auto overscroll-contain px-5 py-4 sm:px-6"
				>
					{renderedOAuth ? (
						<ProviderOAuthFlow
							issue={renderedOAuthIssue}
							verificationUrl={renderedOAuth.verificationUrl}
							userCode={renderedOAuth.userCode}
							starting={acceptProvider.isPending || oauthDeviceStart.isPending}
							polling={oauthDevicePoll.isPending}
							onRestart={() => void runAction(restartOAuth)}
						/>
					) : step === "choose" && !isEdit ? (
						<ProviderChooser onSelect={selectProvider} />
					) : (
						<div className="flex flex-col gap-3">
							{!providerListReady ? (
								providers.isLoading ? (
									<div
										className="flex items-center gap-2 text-sm text-muted-foreground"
										role="status"
									>
										<Spinner className="size-4" /> Loading providers…
									</div>
								) : (
									<Alert variant="destructive">
										<CircleAlert />
										<AlertDescription>
											Providers couldn’t be loaded. Refresh and try again.
										</AlertDescription>
									</Alert>
								)
							) : null}
							<ProviderFieldsForm
								showCustomRouting={showCustomRouting}
								form={form}
								editing={editing ?? null}
								preset={selectedPreset}
								providerLabel={providerLabel}
								apiKeyUrl={
									selectedRegion?.api_key_url ??
									selectedPreset?.api_key_url ??
									meta.apiKeyUrl ??
									null
								}
								onUpdate={(value) => {
									acceptAttemptRef.current = null;

									updateForm(value);
								}}
								onReconnectOAuth={() => void runAction(beginReconnectOAuth)}
								startingOAuth={oauthDeviceStart.isPending}
							/>
						</div>
					)}
				</div>

				{step === "choose" && !isEdit && !renderedOAuth ? null : (
					<DialogFooter className="shrink-0 border-t bg-popover px-5 py-3 sm:px-6 sm:py-4">
						{renderedOAuth ? (
							<Button variant="outline" onClick={() => requestClose(false)} disabled={busy}>
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
				)}
			</DialogContent>
		</Dialog>
	);
}
