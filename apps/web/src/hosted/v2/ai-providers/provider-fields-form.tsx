"use client";
import { providerFieldsFormClasses as styles } from "@clawdi/shared/ui";
import { providerFieldsFormCopy as copy } from "@clawdi/shared/view";

import { ExternalLink, Eye, EyeOff, RefreshCw, UserRound } from "lucide-react";
import { useEffect, useState } from "react";
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
import type { ProviderPreset } from "@/hosted/v2/ai-providers/provider-presets";
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
	providerLabel,
	apiKeyUrl,
	onUpdate,
	onReconnectOAuth,
	startingOAuth,
}: {
	form: ProviderFormState;
	showCustomRouting: boolean;
	editing: AiProvider | null;
	preset: ProviderPreset | null;
	providerLabel: string;
	apiKeyUrl: string | null;
	onUpdate: (value: Partial<ProviderFormState>) => void;
	onReconnectOAuth: () => void;
	startingOAuth: boolean;
}) {
	const meta = providerTypeMeta(form.type);
	const isEdit = editing !== null;
	const isOAuthEdit =
		editing?.auth.type === "agent_profile" || editing?.auth.type === "oauth_profile";
	const savedCredentialAvailable = editing !== null && editing.auth.type !== "none";
	const apiModes =
		form.configurationMode === "custom"
			? Object.keys(API_MODE_LABEL).filter(isApiMode)
			: meta.apiModes;
	const credentialLabel = preset?.credential_label ?? "API key";
	const credentialName = credentialLabel === "API key" ? "API key" : credentialLabel.toLowerCase();
	const [apiKeyVisible, setApiKeyVisible] = useState(false);
	useEffect(() => {
		setApiKeyVisible(false);
	}, [form.authMethod]);

	return (
		<div data-hosted="true" data-v2="true" className={styles.root}>
			<div className={styles.field}>
				<Label htmlFor="provider-label">{copy.name}</Label>
				<Input
					id="provider-label"
					value={form.label}
					onChange={(event) => onUpdate({ label: event.target.value })}
					placeholder={preset?.label ?? providerLabel}
					autoComplete="off"
					required={meta.custom === true && preset === null}
				/>
			</div>

			{form.authMethod === "api_key" && showCustomRouting ? (
				<>
					<div className={styles.field}>
						<Label htmlFor="provider-mode">{copy.apiFormat}</Label>
						<Select
							items={apiModes.map((mode) => ({ value: mode, label: API_MODE_LABEL[mode] }))}
							value={form.apiMode}
							onValueChange={(value) => {
								if (isApiMode(value)) onUpdate({ apiMode: value });
							}}
						>
							<SelectTrigger id="provider-mode" className={styles.select}>
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
					<div className={styles.field}>
						<Label htmlFor="provider-base">{copy.endpoint}</Label>
						<Input
							id="provider-base"
							value={form.baseUrl}
							onChange={(event) => onUpdate({ baseUrl: event.target.value })}
							placeholder={copy.endpointPlaceholder}
							autoComplete="off"
							spellCheck={false}
						/>
					</div>
				</>
			) : null}

			{isOAuthEdit ? (
				<div className={styles.oauth}>
					<UserRound className={styles.oauthIcon} />
					<div className={styles.content}>
						<p className={styles.title}>ChatGPT sign-in</p>
						<p className={styles.hint}>Subscription access</p>
					</div>
					<Button variant="outline" size="sm" onClick={onReconnectOAuth} disabled={startingOAuth}>
						{startingOAuth ? <Spinner /> : <RefreshCw />}
						Reconnect
					</Button>
				</div>
			) : form.authMethod === "api_key" ? (
				<div className={styles.field}>
					<div className={styles.credentialHeader}>
						<Label htmlFor="provider-key">{credentialLabel}</Label>
						{apiKeyUrl ? (
							<a
								href={apiKeyUrl}
								target="_blank"
								rel="noreferrer"
								className={styles.credentialLink}
							>
								{preset?.credential_link_label ?? `Get ${credentialName}`}{" "}
								<ExternalLink className={styles.externalIcon} aria-hidden="true" />
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
								isEdit && savedCredentialAvailable ? copy.keepCredential : `Enter ${credentialName}`
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
