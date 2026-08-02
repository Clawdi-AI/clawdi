"use client";

import { CircleAlert, CircleCheck, FlaskConical, RefreshCw } from "lucide-react";
import { useState } from "react";
import { Button } from "@/components/ui/button";
import {
	Dialog,
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
	DialogTrigger,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { useTestProviderConnection } from "@/hosted/v2/ai-providers/ai-providers-hooks";
import {
	providerConnectionIssueMessage,
	providerConnectionIssueTitle,
} from "@/hosted/v2/ai-providers/provider-connection-feedback";
import type { AiProvider } from "@/hosted/v2/ai-providers/types";

export function ProviderConnectionTest({
	provider,
	providerLabel,
}: {
	provider: AiProvider;
	providerLabel: string;
}) {
	const testConnection = useTestProviderConnection();
	const [open, setOpen] = useState(false);
	const testable = provider.auth.type === "api_key" && provider.auth.source === "managed";
	const testedModel = provider.models?.[0]?.id;
	if (!testable) return null;

	function runTest() {
		testConnection.mutate({
			params: { path: { provider_id: provider.provider_id } },
			body: testedModel ? { model: testedModel } : {},
		});
	}

	function changeOpen(next: boolean) {
		setOpen(next);
	}

	const result = testConnection.data;
	return (
		<Dialog
			open={open}
			onOpenChange={changeOpen}
			onOpenChangeComplete={(nextOpen) => {
				if (!nextOpen) testConnection.reset();
			}}
		>
			<DialogTrigger
				render={
					<Button variant="ghost" size="sm" aria-label={`Test connection for ${providerLabel}`} />
				}
			>
				<FlaskConical />
				Test connection
			</DialogTrigger>
			<DialogContent data-hosted="true" data-v2="true" className="sm:max-w-md">
				<DialogHeader>
					<DialogTitle>Test connection</DialogTitle>
					<DialogDescription>
						Verify {providerLabel} with one minimal model request. This may incur a small provider
						charge.
					</DialogDescription>
				</DialogHeader>
				<div aria-live="polite" className="min-h-28 py-2">
					{testConnection.isPending ? (
						<div className="flex min-h-24 flex-col items-center justify-center gap-2 text-sm text-muted-foreground">
							<Spinner className="size-5" /> Contacting provider…
						</div>
					) : testConnection.isError ? (
						<div className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3">
							<CircleAlert className="mt-0.5 size-5 shrink-0 text-destructive" />
							<div>
								<p className="text-sm font-medium">Couldn't start the connection test</p>
								<p className="mt-1 text-xs text-muted-foreground">
									Check your network and try again. Your saved provider was not changed.
								</p>
							</div>
						</div>
					) : result?.ok ? (
						<div className="flex items-start gap-3 rounded-lg border border-success/30 bg-success-muted p-3">
							<CircleCheck className="mt-0.5 size-5 shrink-0 text-success" />
							<div>
								<p className="text-sm font-medium">Connection verified</p>
								<p className="mt-1 text-xs text-muted-foreground">
									{testedModel
										? "The saved credentials and first configured model are working."
										: "The saved credentials and provider connection are working."}
								</p>
							</div>
						</div>
					) : result ? (
						<div className="flex items-start gap-3 rounded-lg border border-warning/30 bg-warning-muted p-3">
							<CircleAlert className="mt-0.5 size-5 shrink-0 text-warning-muted-foreground" />
							<div>
								<p className="text-sm font-medium">
									{providerConnectionIssueTitle(result.error)} needs attention
								</p>
								<p className="mt-1 text-xs text-muted-foreground">
									{providerConnectionIssueMessage(result.error)}
								</p>
							</div>
						</div>
					) : (
						<div className="flex min-h-24 items-center justify-center rounded-lg border bg-muted/20 p-3 text-center text-sm text-muted-foreground">
							Ready to test. Your saved provider settings won't be changed.
						</div>
					)}
				</div>
				<DialogFooter>
					<Button variant="outline" onClick={() => changeOpen(false)}>
						Close
					</Button>
					<Button onClick={runTest} disabled={testConnection.isPending}>
						{testConnection.isPending ? <Spinner /> : <RefreshCw />}
						{result || testConnection.isError ? "Test again" : "Run test"}
					</Button>
				</DialogFooter>
			</DialogContent>
		</Dialog>
	);
}
