"use client";

import { Link } from "@tanstack/react-router";
import { AlertTriangle, RotateCcw, X } from "lucide-react";
import { useEffect, useRef, useState } from "react";
import { EmptyState } from "@/components/empty-state";
import { HostedRouteSkeleton } from "@/components/hosted-route-skeleton";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { Button } from "@/components/ui/button";
import {
	consumeHermesRuntimeWindowLaunch,
	type HermesRuntimeWindowLaunch,
} from "@/hosted/agents/runtime-window-lifecycle";
import { cn } from "@/lib/utils";

export function RuntimeWindowSurface({ reason }: { reason: string | null }) {
	const [launch, setLaunch] = useState<HermesRuntimeWindowLaunch | null>(null);
	const [launchChecked, setLaunchChecked] = useState(false);
	const launchConsumedRef = useRef(false);
	useEffect(() => {
		if (launchConsumedRef.current) return;
		launchConsumedRef.current = true;
		setLaunch(consumeHermesRuntimeWindowLaunch());
		setLaunchChecked(true);
	}, []);

	if (reason) return <RuntimeWindowStatus reason={reason} />;
	if (!launchChecked) return <HostedRouteSkeleton />;
	if (!launch) return <RuntimeWindowStatus reason={null} />;
	return (
		<iframe
			src={launch.url}
			title="Hermes Dashboard"
			className="h-dvh w-full border-0 bg-background"
			allow="clipboard-read; clipboard-write"
		/>
	);
}

function RuntimeWindowStatus({ reason }: { reason: string | null }) {
	const deleting = reason === "deleting";
	const restarted = reason === "restarted";
	const title = deleting
		? "Agent removal started"
		: restarted
			? "This runtime window is out of date"
			: "This runtime window is no longer current";
	const description = deleting
		? "Clawdi accepted deletion of this agent. Cleanup may still be finishing, but this window no longer represents a runtime you can keep using."
		: restarted
			? "Clawdi accepted a restart for this agent. This window belongs to the previous runtime session and cannot report whether the new session is usable. When Clawdi shows Running, open Agent Interface again and sign in."
			: "Clawdi can no longer connect this window to a current agent state. Return to Agents before opening another runtime interface.";

	return (
		<div
			data-hosted="true"
			data-v2="true"
			className={cn(CENTERED_PAGE_WIDTH_CLASS.page, "flex min-h-[60vh] items-center px-4 lg:px-6")}
		>
			<EmptyState
				icon={restarted ? RotateCcw : AlertTriangle}
				title={title}
				description={description}
				action={
					<div className="flex flex-wrap justify-center gap-2">
						<Button type="button" onClick={() => window.close()}>
							<X /> Close this window
						</Button>
						<Button render={<Link to="/agents" />} nativeButton={false} variant="outline">
							View Agents here
						</Button>
					</div>
				}
			/>
		</div>
	);
}
