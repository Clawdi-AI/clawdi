"use client";

import { Check, Copy } from "lucide-react";
import { Button } from "@/components/ui/button";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";

/**
 * Copy-to-clipboard icon button with the app's success affordance: the icon
 * flips to a check for ~1.5s and a toast confirms. When the clipboard is
 * blocked, a generic failure toast appears while the source field stays
 * selectable. Used by wallet and deployment surfaces.
 */
export function CopyButton({
	value,
	label,
	toastMessage = "Copied to clipboard",
	errorToastMessage,
}: {
	value: string;
	label: string;
	toastMessage?: string;
	errorToastMessage?: string;
}) {
	const { copied, copy } = useCopyToClipboard({
		success: toastMessage,
		error: errorToastMessage,
	});

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
