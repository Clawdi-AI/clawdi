"use client";

import { providerOAuthFlowClasses } from "@clawdi/shared/ui";
import { providerOAuthCopy as copy } from "@clawdi/shared/view";

import { Check, CircleAlert, Copy, ExternalLink } from "lucide-react";
import { useState } from "react";
import { toast } from "sonner";
import { Button, buttonVariants } from "@/components/ui/button";
import { Spinner } from "@/components/ui/spinner";

export type OAuthIssue = "expired" | "failed";

export function ProviderOAuthFlow({
	issue,
	verificationUrl,
	userCode,
	starting,
	polling,
	onRestart,
}: {
	issue: OAuthIssue | null;
	verificationUrl: string;
	userCode: string;
	starting: boolean;
	polling: boolean;
	onRestart: () => void;
}) {
	const [copied, setCopied] = useState(false);

	async function copyCode() {
		try {
			await navigator.clipboard.writeText(userCode);
			setCopied(true);
			setTimeout(() => setCopied(false), 1500);
		} catch {
			toast.error("Couldn't copy the code");
		}
	}

	return (
		<div data-hosted="true" data-v2="true" className={providerOAuthFlowClasses.root}>
			<div className={providerOAuthFlowClasses.tile}>
				<p className={providerOAuthFlowClasses.label}>{copy.code}</p>
				<div className={providerOAuthFlowClasses.codeRow}>
					<code className={providerOAuthFlowClasses.code}>{userCode}</code>
					<Button
						variant="ghost"
						size="icon"
						onClick={() => void copyCode()}
						aria-label="Copy code"
					>
						{copied ? <Check /> : <Copy />}
					</Button>
				</div>
			</div>

			<a
				href={verificationUrl}
				target="_blank"
				rel="noopener noreferrer"
				className={buttonVariants({ className: "w-full" })}
			>
				{copy.open} <ExternalLink />
			</a>

			<div aria-live="polite">
				{issue === "expired" ? (
					<p className={providerOAuthFlowClasses.error}>
						<CircleAlert className={providerOAuthFlowClasses.icon} /> {copy.expired}
					</p>
				) : issue === "failed" ? (
					<p className={providerOAuthFlowClasses.error}>
						<CircleAlert className={providerOAuthFlowClasses.icon} /> {copy.failed}
					</p>
				) : (
					<p className={providerOAuthFlowClasses.waiting}>
						{polling ? <Spinner className={providerOAuthFlowClasses.icon} /> : null} {copy.waiting}
					</p>
				)}
			</div>

			{issue ? (
				<Button variant="outline" onClick={onRestart} disabled={starting}>
					{starting ? <Spinner /> : null}
					{copy.restart}
				</Button>
			) : null}
		</div>
	);
}
