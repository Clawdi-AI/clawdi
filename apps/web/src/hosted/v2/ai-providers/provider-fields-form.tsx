"use client";

import { CircleAlert, ExternalLink, KeyRound, RefreshCw, UserRound } from "lucide-react";
import { EntityChoiceCard } from "@/components/entity-card";
import { EntityIcon } from "@/components/entity-icon";
import { Button } from "@/components/ui/button";
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
import type { AuthMethod } from "@/hosted/v2/ai-providers/add-provider-dialog.logic";
import { ProviderTypeChip } from "@/hosted/v2/ai-providers/ai-providers-ui";
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
	onReplaceApiKey,
	onReconnectOAuth,
	replacingApiKey,
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
	onReplaceApiKey: () => void;
	onReconnectOAuth: () => void;
	replacingApiKey: boolean;
	startingOAuth: boolean;
}) {
	const meta = providerTypeMeta(form.type);
	const isEdit = editing !== null;
	const isOAuthEdit =
		editing?.auth.type === "agent_profile" || editing?.auth.type === "oauth_profile";
	const apiModes = meta.apiModes;
	const regions = preset?.region_variants ?? [];
	const showName = isEdit || meta.custom === true;
	const showRuntimeEnv = !isOAuthEdit && form.authMethod === "api_key";

	return (
		<div data-hosted="true" data-v2="true" className="flex flex-col gap-4">
			<div className="flex items-center gap-3 rounded-lg border bg-muted/30 p-3">
				{preset ? (
					<EntityIcon kind="provider" id={preset.id} label={preset.label} size="md" />
				) : (
					<ProviderTypeChip type={form.type} />
				)}
				<div className="min-w-0 flex-1">
					<p className="text-sm font-medium text-foreground">{providerLabel}</p>
					<p className="truncate text-xs text-muted-foreground">
						Saved as <code className="font-mono">{providerId || "—"}</code>
					</p>
				</div>
			</div>

			{showName ? (
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="provider-label">Name</Label>
					<Input
						id="provider-label"
						value={form.label}
						onChange={(event) => onUpdate({ label: event.target.value })}
						placeholder={preset?.label ?? "Custom endpoint"}
						autoComplete="off"
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
						<SelectTrigger id="provider-region">
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
					<p className="break-all text-xs text-muted-foreground">{region?.base_url}</p>
				</div>
			) : null}

			{!isEdit && meta.oauth ? (
				<fieldset className="flex flex-col gap-2">
					<legend className="text-sm font-medium">Authentication</legend>
					<div className="grid gap-2 sm:grid-cols-2">
						<EntityChoiceCard
							selected={form.authMethod === "api_key"}
							onClick={() => onAuthMethodChange("api_key")}
							icon={<KeyRound className="size-4" />}
							title="API key"
							description="Use metered API billing"
						/>
						<EntityChoiceCard
							selected={form.authMethod === "oauth"}
							onClick={() => onAuthMethodChange("oauth")}
							icon={<UserRound className="size-4" />}
							title="Sign in with ChatGPT"
							description="Use your Codex subscription"
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
							Reconnect only when you want to change or repair the account.
						</p>
					</div>
					<Button variant="outline" size="sm" onClick={onReconnectOAuth} disabled={startingOAuth}>
						{startingOAuth ? <Spinner /> : <RefreshCw />}
						Reconnect
					</Button>
				</div>
			) : form.authMethod === "api_key" ? (
				<div className="flex flex-col gap-1.5">
					<Label htmlFor="provider-key">
						API key{isEdit && editing?.usable ? " (leave blank to keep)" : ""}
					</Label>
					<div className="flex flex-col gap-2 sm:flex-row">
						<Input
							id="provider-key"
							type="password"
							value={form.apiKey}
							onChange={(event) => onUpdate({ apiKey: event.target.value })}
							placeholder="sk-…"
							autoComplete="off"
							spellCheck={false}
						/>
						{isEdit ? (
							<Button
								type="button"
								variant="outline"
								onClick={onReplaceApiKey}
								disabled={!form.apiKey.trim() || replacingApiKey}
							>
								{replacingApiKey ? <Spinner /> : <KeyRound />}
								{editing?.usable ? "Replace key" : "Save key"}
							</Button>
						) : null}
					</div>
					<p className="text-xs text-muted-foreground">
						{isEdit
							? "Credential changes are saved separately, so a settings error cannot partially replace your key."
							: "Encrypted at rest and never shown again."}
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
					{isEdit && editing?.auth.type === "none" ? (
						<p className="flex items-start gap-1.5 text-xs text-warning-muted-foreground">
							<CircleAlert className="mt-0.5 size-3.5 shrink-0" /> This legacy provider has no
							credential. Save a key before assigning it to a hosted agent.
						</p>
					) : null}
				</div>
			) : (
				<div className="rounded-lg border bg-muted/30 p-3 text-sm">
					You’ll finish setup in a ChatGPT window. No API key is required here.
				</div>
			)}

			<details className="group rounded-lg border bg-muted/20" open={meta.custom || isEdit}>
				<summary className="cursor-pointer list-none px-3 py-2.5 text-sm font-medium marker:hidden">
					Advanced
					<span className="float-right text-muted-foreground transition-transform group-open:rotate-180">
						⌄
					</span>
				</summary>
				<div className="flex flex-col gap-3 border-t p-3">
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
								<SelectTrigger id="provider-mode">
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
		</div>
	);
}
