import { Info } from "lucide-react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";
import { runtimeDisplayName } from "@/hosted/runtimes";
import type { ProviderConflictNotice } from "@/hosted/v2/ai-providers/provider-conflicts";

export const KEEP_AGENT_SETTINGS_LABEL = "Keep the agent’s own settings";

export function providerConflictDescription(notice: ProviderConflictNotice): string {
	const runtime = runtimeDisplayName(notice.runtime);
	return notice.code === "native_credential_pool_conflict"
		? `The agent already stores its own key for this provider in ${runtime}, so Clawdi kept it. Nothing was changed.`
		: `The agent’s own ${runtime} settings already set up this provider, so Clawdi kept them. Nothing was changed.`;
}

export function providerConflictHandBackHint(notice: ProviderConflictNotice): string {
	return `To let Clawdi manage it instead, remove it from the agent’s ${runtimeDisplayName(notice.runtime)} settings. Clawdi applies it within about 5 minutes.`;
}

export function ProviderConflictNotices({
	items,
	keepPending,
	keepDisabled,
	onKeepAgentSettings,
}: {
	items: readonly { notice: ProviderConflictNotice; label: string }[];
	keepPending: boolean;
	keepDisabled: boolean;
	onKeepAgentSettings: () => void;
}) {
	if (items.length === 0) return null;
	return (
		<div data-hosted="true" data-v2="true" className="flex flex-col gap-3">
			{items.map(({ notice, label }) => (
				<Alert
					key={notice.providerId}
					data-provider-conflict={notice.providerId}
					className="border-info-muted bg-info-muted text-info-muted-foreground"
				>
					<Info aria-hidden />
					<AlertTitle>{label} isn’t applied</AlertTitle>
					<AlertDescription className="flex flex-col items-start gap-3">
						<span>{providerConflictDescription(notice)}</span>
						{notice.removable ? (
							<Button
								type="button"
								size="sm"
								disabled={keepDisabled || keepPending}
								onClick={onKeepAgentSettings}
							>
								{keepPending ? <Spinner className="size-3.5" /> : null}
								{KEEP_AGENT_SETTINGS_LABEL}
							</Button>
						) : (
							<span>To keep the agent’s own settings, choose another option below and save.</span>
						)}
						<span className="text-xs">{providerConflictHandBackHint(notice)}</span>
					</AlertDescription>
				</Alert>
			))}
		</div>
	);
}
