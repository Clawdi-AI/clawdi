"use client";

import {
	ChevronDown,
	ExternalLink,
	Eye,
	EyeOff,
	KeyRound,
	RefreshCw,
	UserRound,
} from "lucide-react";
import { useCallback, useEffect, useState } from "react";
import { EntityChoiceCard } from "@/components/entity-card";
import { IconChip } from "@/components/icon-chip";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
	InputGroup,
	InputGroupAddon,
	InputGroupButton,
	InputGroupInput,
} from "@/components/ui/input-group";
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
import type { AuthMethod } from "@/hosted/v2/ai-providers/add-provider-dialog.logic";
import type {
	ProviderPreset,
	ProviderPresetRegionVariant,
} from "@/hosted/v2/ai-providers/provider-presets";
import {
	API_MODE_LABEL,
	type ApiMode,
	providerTypeMeta,
} from "@/hosted/v2/ai-providers/provider-types";
import type { AiProvider } from "@/hosted/v2/ai-providers/types";
import type { ProviderFormState } from "@/hosted/v2/ai-providers/use-provider-form";

function isApiMode(value: string | null): value is ApiMode {
	return (
		value === "openai_chat" ||
		value === "openai_responses" ||
		value === "anthropic_messages" ||
		value === "google_generate_content"
	);
}

export function ProviderFieldsForm({
	form,
	editing,
	preset,
	region,
	providerId,
	providerLabel,
	apiKeyUrl,
	onUpdate,
	onAuthMethodChange,
	onRegionChange,
	onReconnectOAuth,
	startingOAuth,
}: {
	form: ProviderFormState;
	editing: AiProvider | null;
	preset: ProviderPreset | null;
	region: ProviderPresetRegionVariant | null;
	providerId: string;
	providerLabel: string;
	apiKeyUrl: string | null;
	onUpdate: (value: Partial<ProviderFormState>) => void;
	onAuthMethodChange: (method: AuthMethod) => void;
	onRegionChange: (regionId: string) => void;
	onReconnectOAuth: () => void;
	startingOAuth: boolean;
}) {
	const meta = providerTypeMeta(form.type);
	const isEdit = editing !== null;
	const isOAuthEdit =
		editing?.auth.type === "agent_profile" || editing?.auth.type === "oauth_profile";
	const savedCredentialAvailable = editing !== null && editing.auth.type !== "none";
	const apiModes = meta.apiModes;
	const regions = preset?.region_variants ?? [];
	const isCustomEndpoint = meta.custom === true && preset === null;
	const showPrimaryName = isCustomEndpoint;
	const showAdvancedName = preset !== null || (!showPrimaryName && isEdit);
	const showRuntimeEnv = !isOAuthEdit && form.authMethod === "api_key";
	const defaultAdvancedOpen = isCustomEndpoint;
	const [apiKeyVisible, setApiKeyVisible] = useState(false);
	useEffect(() => {
		setApiKeyVisible(false);
	}, [form.authMethod]);
	// React has no defaultOpen prop for native details. Initialize once through a
	// stable ref so later renders leave the user's disclosure state untouched.
	const initializeAdvancedDetails = useCallback(
		(details: HTMLDetailsElement | null) => {
			if (details) details.open = defaultAdvancedOpen;
		},
		[defaultAdvancedOpen],
	);

	return (
		<div data-hosted="true" data-v2="true" className="flex flex-col gap-4">
			{showPrimaryName ? (
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="provider-label">Name</Label>
					<Input
						id="provider-label"
						value={form.label}
						onChange={(event) => onUpdate({ label: event.target.value })}
						placeholder="Custom endpoint"
						autoComplete="off"
						required
					/>
				</div>
			) : null}

			{regions.length > 0 ? (
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="provider-region">Region</Label>
					<Select
						items={regions.map((item) => ({ value: item.id, label: item.label }))}
						value={region?.id ?? regions[0]?.id ?? ""}
						onValueChange={(value) => {
							if (value) onRegionChange(value);
						}}
					>
						<SelectTrigger id="provider-region" className="w-full">
							<SelectValue />
						</SelectTrigger>
						<SelectContent>
							{regions.map((item) => (
								<SelectItem key={item.id} value={item.id}>
									{item.label}
								</SelectItem>
							))}
						</SelectContent>
					</Select>
				</div>
			) : null}

			{!isEdit && meta.oauth ? (
				<fieldset className="flex flex-col gap-2">
					<legend className="text-sm font-medium">Authentication</legend>
					<div className="grid gap-2 sm:grid-cols-2">
						<EntityChoiceCard
							selected={form.authMethod === "api_key"}
							onClick={() => onAuthMethodChange("api_key")}
							icon={
								<IconChip size="sm" className="size-6">
									<KeyRound />
								</IconChip>
							}
							title="Sign in with an API key"
							description="For usage-based access"
							variant="compact"
						/>
						<EntityChoiceCard
							selected={form.authMethod === "oauth"}
							onClick={() => onAuthMethodChange("oauth")}
							icon={
								<IconChip size="sm" className="size-6">
									<UserRound />
								</IconChip>
							}
							title="Sign in with ChatGPT"
							description="For subscription access"
							variant="compact"
						/>
					</div>
				</fieldset>
			) : null}

			{isOAuthEdit ? (
				<div className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center">
					<UserRound className="size-4 shrink-0 text-muted-foreground" />
					<div className="min-w-0 flex-1">
						<p className="text-sm font-medium">ChatGPT sign-in</p>
						<p className="text-xs text-muted-foreground">
							Subscription access. Reconnect only to change or repair the account.
						</p>
					</div>
					<Button variant="outline" size="sm" onClick={onReconnectOAuth} disabled={startingOAuth}>
						{startingOAuth ? <Spinner /> : <RefreshCw />}
						Reconnect
					</Button>
				</div>
			) : form.authMethod === "api_key" ? (
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="provider-key">API key</Label>
					<InputGroup>
						<InputGroupInput
							id="provider-key"
							type={apiKeyVisible ? "text" : "password"}
							value={form.apiKey}
							onChange={(event) => onUpdate({ apiKey: event.target.value })}
							placeholder={
								isEdit && savedCredentialAvailable
									? "Leave blank to keep current key"
									: "Enter API key"
							}
							autoComplete="off"
							autoCapitalize="none"
							autoCorrect="off"
							spellCheck={false}
							aria-describedby="provider-key-help"
						/>
						<InputGroupAddon align="inline-end">
							<InputGroupButton
								size="icon-xs"
								onClick={() => setApiKeyVisible((visible) => !visible)}
								aria-label={apiKeyVisible ? "Hide API key" : "Show API key"}
								aria-pressed={apiKeyVisible}
							>
								{apiKeyVisible ? <EyeOff /> : <Eye />}
							</InputGroupButton>
						</InputGroupAddon>
					</InputGroup>
					<p id="provider-key-help" className="text-xs text-muted-foreground">
						{isEdit
							? editing?.auth.type === "none"
								? "Enter an API key to finish setup."
								: "Leave blank to keep the current key."
							: "Encrypted at rest and never shown again."}
					</p>
					{meta.oauth ? (
						<p className="text-xs text-muted-foreground">
							OpenAI bills API key usage through your Platform account at standard API rates.
						</p>
					) : null}
					<p className="text-xs text-muted-foreground">
						Testing sends one minimal inference request and may incur a small provider charge.
					</p>
					{apiKeyUrl ? (
						<a
							href={apiKeyUrl}
							target="_blank"
							rel="noreferrer"
							className="inline-flex w-fit items-center gap-1 text-xs font-medium text-primary hover:underline"
						>
							Get API key <ExternalLink className="size-3" />
						</a>
					) : null}
				</div>
			) : (
				<div className="rounded-lg border bg-muted/30 p-3 text-sm">
					You’ll finish setup on ChatGPT. No API key is required here.
				</div>
			)}

			{form.authMethod === "api_key" ? (
				<details ref={initializeAdvancedDetails} className="group rounded-lg border bg-muted/20">
					<summary className="flex cursor-pointer list-none items-center justify-between gap-2 px-3 py-2.5 text-sm font-medium marker:hidden">
						Advanced
						<ChevronDown
							className="size-4 shrink-0 text-muted-foreground transition-transform group-open:rotate-180"
							aria-hidden
						/>
					</summary>
					<div className="flex flex-col gap-3 border-t p-3">
						{showAdvancedName ? (
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="provider-label">Name</Label>
								<Input
									id="provider-label"
									value={form.label}
									onChange={(event) => onUpdate({ label: event.target.value })}
									placeholder={preset?.label ?? providerLabel}
									autoComplete="off"
								/>
							</div>
						) : null}
						<div className="flex flex-col gap-1.5">
							<p className="text-sm font-medium">Provider ID</p>
							<code className="w-fit max-w-full break-all rounded bg-muted px-2 py-1 font-mono text-xs text-muted-foreground">
								{providerId || "—"}
							</code>
						</div>
						<div className="flex flex-col gap-1.5">
							<Label htmlFor="provider-base">Base URL</Label>
							<Input
								id="provider-base"
								value={form.baseUrl}
								onChange={(event) => onUpdate({ baseUrl: event.target.value })}
								placeholder="https://api.example.com/v1"
								autoComplete="off"
								spellCheck={false}
							/>
						</div>
						<div className="grid gap-3 sm:grid-cols-2">
							<div className="flex flex-col gap-1.5">
								<Label htmlFor="provider-mode">API mode</Label>
								<Select
									items={apiModes.map((mode) => ({ value: mode, label: API_MODE_LABEL[mode] }))}
									value={form.apiMode}
									onValueChange={(value) => {
										if (isApiMode(value)) onUpdate({ apiMode: value });
									}}
								>
									<SelectTrigger id="provider-mode" className="w-full">
										<SelectValue />
									</SelectTrigger>
									<SelectContent>
										{apiModes.map((mode) => (
											<SelectItem key={mode} value={mode}>
												{API_MODE_LABEL[mode]}
											</SelectItem>
										))}
									</SelectContent>
								</Select>
							</div>
							{showRuntimeEnv ? (
								<div className="flex flex-col gap-1.5">
									<Label htmlFor="provider-env">Agent environment variable</Label>
									<Input
										id="provider-env"
										value={form.runtimeEnv}
										onChange={(event) => onUpdate({ runtimeEnv: event.target.value.toUpperCase() })}
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
								value={form.modelsText}
								onChange={(event) => onUpdate({ modelsText: event.target.value })}
								placeholder={meta.modelPlaceholder}
								className="min-h-24 resize-y"
								autoComplete="off"
								spellCheck={false}
							/>
							<p className="text-xs text-muted-foreground">
								One model id per line. The first is used by connection testing.
							</p>
						</div>
					</div>
				</details>
			) : null}
		</div>
	);
}
