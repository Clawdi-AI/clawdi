"use client";

import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCopyToClipboard } from "@/hosted/use-copy-to-clipboard";

/**
 * Copy-to-clipboard icon button with the app's success affordance: the icon
 * flips to a check for ~1.5s and a toast confirms. Falls back silently when
 * the clipboard is blocked (insecure context) — the source field stays
 * selectable. Used by wallet and deployment surfaces.
 */
export function CopyButton({
	value,
	label,
	toastMessage = "Copied to clipboard",
}: {
	value: string;
	label: string;
	toastMessage?: string;
}) {
	const { copied, copy } = useCopyToClipboard({ success: toastMessage });

	return (
		<Button
			data-hosted="true"
			type="button"
			size="icon-sm"
			variant="ghost"
			onClick={() => copy(value)}
			aria-label={label}
			data-copied={copied}
		>
			{copied ? <Check className="text-success" /> : <Copy />}
		</Button>
	);
}
