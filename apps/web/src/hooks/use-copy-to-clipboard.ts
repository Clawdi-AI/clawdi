"use client";

import { useEffect, useRef, useState } from "react";
import { toast } from "sonner";

interface CopyToastCopy {
	/** Success toast title. Defaults to "Copied to clipboard"; false suppresses it. */
	success?: string | false;
	/** Failure toast title (clipboard blocked / insecure context). */
	error?: string;
}

function copyWithSelection(value: string): boolean {
	const textarea = document.createElement("textarea");
	const activeElement = document.activeElement;
	textarea.value = value;
	textarea.setAttribute("readonly", "");
	textarea.style.position = "fixed";
	textarea.style.opacity = "0";
	try {
		document.body.appendChild(textarea);
		textarea.select();
		return document.execCommand("copy");
	} finally {
		textarea.remove();
		if (activeElement instanceof HTMLElement) activeElement.focus();
	}
}

/**
 * Shared copy-to-clipboard affordance: writes to the clipboard, flips a
 * `copied` flag true for the requested duration (default 1.5s), and toasts.
 * Each surface passes its own toast copy so wording stays put; only the
 * clipboard write, the reset, and the
 * success/failure split are shared. Used by the billing `CopyButton` and the
 * channels token/inline copy controls.
 */
export function useCopyToClipboard(toasts: CopyToastCopy = {}, duration = 1500) {
	const [copied, setCopied] = useState(false);
	const resetTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
	const mounted = useRef(true);
	useEffect(() => {
		mounted.current = true;
		return () => {
			mounted.current = false;
			if (resetTimer.current !== null) clearTimeout(resetTimer.current);
		};
	}, []);
	async function copy(value: string) {
		try {
			try {
				await navigator.clipboard.writeText(value);
			} catch {
				if (!copyWithSelection(value)) throw new Error("Clipboard unavailable");
			}
			if (!mounted.current) return;
			if (resetTimer.current !== null) clearTimeout(resetTimer.current);
			setCopied(true);
			if (toasts.success !== false) toast.success(toasts.success ?? "Copied to clipboard");
			resetTimer.current = setTimeout(() => setCopied(false), duration);
		} catch {
			if (!mounted.current) return;
			if (resetTimer.current !== null) clearTimeout(resetTimer.current);
			setCopied(false);
			toast.error(toasts.error ?? "Couldn't copy — select and copy manually.");
		}
	}
	return { copied, copy };
}
