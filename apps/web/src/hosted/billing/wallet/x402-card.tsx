"use client";

import { Link2 } from "lucide-react";
import { SettingsSection } from "@/components/settings-section";
import { Badge } from "@/components/ui/badge";

export function X402Card() {
	return (
		<SettingsSection
			headingLevel={3}
			data-hosted="true"
			title={
				<span className="flex flex-wrap items-center gap-2">
					<span className="inline-flex items-center gap-2">
						<Link2 className="size-4" aria-hidden /> USDC via x402
					</span>
					<Badge variant="secondary">Coming soon</Badge>
				</span>
			}
			description="Agents will be able to add Wallet funds with USDC."
		/>
	);
}
