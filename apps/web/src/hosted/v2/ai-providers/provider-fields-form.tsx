"use client";

import { ExternalLink, Eye, EyeOff, KeyRound, RefreshCw, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
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
	showCustomRouting,
	editing,
	preset,
	region,
	providerLabel,
	apiKeyUrl,
	onUpdate,
	onAuthMethodChange,
	onRegionChange,
	onReconnectOAuth,
	startingOAuth,
}: {
	form: ProviderFormState;
	showCustomRouting: boolean;
	editing: AiProvider | null;
	preset: ProviderPreset | null;
	region: ProviderPresetRegionVariant | null;
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
	const credentialLabel = preset?.credential_label ?? "API key";
	const credentialName = credentialLabel === "API key" ? "API key" : credentialLabel.toLowerCase();
	const [apiKeyVisible, setApiKeyVisible] = useState(false);
	useEffect(() => {
		setApiKeyVisible(false);
	}, [form.authMethod]);

	return (
		<div data-hosted="true" data-v2="true" className="flex flex-col gap-4">
			<div className="flex flex-col gap-1.5">
				<Label htmlFor="provider-label">Name</Label>
				<Input
					id="provider-label"
					value={form.label}
					onChange={(event) => onUpdate({ label: event.target.value })}
					placeholder={preset?.label ?? providerLabel}
					autoComplete="off"
					required={meta.custom === true && preset === null}
				/>
			</div>

			{regions.length > 0 ? (
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="provider-region">{preset?.variant_label ?? "Region / plan"}</Label>
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

			{form.authMethod === "api_key" && showCustomRouting ? (
				<>
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="provider-mode">API format</Label>
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
					<div className="flex flex-col gap-1.5">
						<Label htmlFor="provider-base">Endpoint</Label>
						<Input
							id="provider-base"
							value={form.baseUrl}
							onChange={(event) => onUpdate({ baseUrl: event.target.value })}
							placeholder="https://api.example.com/v1"
							autoComplete="off"
							spellCheck={false}
						/>
					</div>
				</>
			) : null}

			{isOAuthEdit ? (
				<div className="flex flex-col gap-3 rounded-lg border p-3 sm:flex-row sm:items-center">
					<UserRound className="size-4 shrink-0 text-muted-foreground" />
					<div className="min-w-0 flex-1">
						<p className="text-sm font-medium">ChatGPT sign-in</p>
						<p className="text-xs text-muted-foreground">Subscription access</p>
					</div>
					<Button variant="outline" size="sm" onClick={onReconnectOAuth} disabled={startingOAuth}>
						{startingOAuth ? <Spinner /> : <RefreshCw />}
						Reconnect
					</Button>
				</div>
			) : form.authMethod === "api_key" ? (
				<div className="flex flex-col gap-1.5">
					<div className="flex items-center justify-between gap-2">
						<Label htmlFor="provider-key">{credentialLabel}</Label>
						{apiKeyUrl ? (
							<a
								href={apiKeyUrl}
								target="_blank"
								rel="noreferrer"
								className="inline-flex shrink-0 items-center gap-1 text-xs font-medium text-primary hover:underline"
							>
								{preset?.credential_link_label ?? `Get ${credentialName}`}{" "}
								<ExternalLink className="size-3" aria-hidden="true" />
							</a>
						) : null}
					</div>
					<InputGroup>
						<InputGroupInput
							id="provider-key"
							type={apiKeyVisible ? "text" : "password"}
							value={form.apiKey}
							onChange={(event) => onUpdate({ apiKey: event.target.value })}
							placeholder={
								isEdit && savedCredentialAvailable
									? "Leave blank to keep current credential"
									: `Enter ${credentialName}`
							}
							autoComplete="off"
							autoCapitalize="none"
							autoCorrect="off"
							spellCheck={false}
						/>
						<InputGroupAddon align="inline-end">
							<InputGroupButton
								size="icon-xs"
								onClick={() => setApiKeyVisible((visible) => !visible)}
								aria-label={`${apiKeyVisible ? "Hide" : "Show"} ${credentialName}`}
								aria-pressed={apiKeyVisible}
							>
								{apiKeyVisible ? <EyeOff /> : <Eye />}
							</InputGroupButton>
						</InputGroupAddon>
					</InputGroup>
				</div>
			) : null}
		</div>
	);
}
