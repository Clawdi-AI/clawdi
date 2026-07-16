"use client";

import { AlertCircle, RefreshCw } from "lucide-react";
import { Component, type ReactNode } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";

export class SettingsPanelErrorBoundary extends Component<
	{ children: ReactNode },
	{ failed: boolean }
> {
	state = { failed: false };

	static getDerivedStateFromError() {
		return { failed: true };
	}

	render() {
		if (!this.state.failed) return this.props.children;

		return (
			<Alert variant="destructive">
				<AlertCircle aria-hidden />
				<AlertTitle>Couldn’t load this settings section</AlertTitle>
				<AlertDescription className="flex flex-col items-start gap-3">
					<span>The settings code didn’t finish loading. Reload the page to try again.</span>
					<Button
						type="button"
						size="sm"
						variant="outline"
						onClick={() => window.location.reload()}
					>
						<RefreshCw data-icon="inline-start" /> Reload settings
					</Button>
				</AlertDescription>
			</Alert>
		);
	}
}
