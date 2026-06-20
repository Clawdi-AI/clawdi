"use client";

import { useState } from "react";
import { toast } from "sonner";

interface CopyToastCopy {
	/** Success toast title. Defaults to "Copied to clipboard". */
	success?: string;
	/** Failure toast title (clipboard blocked / insecure context). */
	error?: string;
}

/**
 * Shared copy-to-clipboard affordance: writes to the clipboard, flips a
 * `copied` flag true for ~1.5s, and toasts. Each surface passes its own toast
 * copy so wording stays put; only the clipboard write, the reset, and the
 * success/failure split are shared. Used by the billing `CopyButton` and the
 * channels token/inline copy controls.
 */
export function useCopyToClipboard(toasts: CopyToastCopy = {}) {
	const [copied, setCopied] = useState(false);
	async function copy(value: string) {
		try {
			await navigator.clipboard.writeText(value);
			setCopied(true);
			toast.success(toasts.success ?? "Copied to clipboard");
			setTimeout(() => setCopied(false), 1500);
		} catch {
			toast.error(toasts.error ?? "Couldn’t copy — select and copy manually.");
		}
	}
	return { copied, copy };
}
