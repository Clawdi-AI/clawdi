import { toast } from "sonner";

/* Thin wrapper over sonner enforcing the DESIGN.md toast rules:
 * - stable ids so repeated triggers update in place instead of stacking
 * - errors carry an inline retry action when the caller can retry
 * - copy: sentence case, active voice, no exclamation marks
 *
 * Use these instead of importing `toast` directly in feature code. */

type ToastOpts = {
	/** Stable id — defaults to the message so identical toasts coalesce. */
	id?: string;
	description?: string;
};

export function toastError(message: string, opts?: ToastOpts & { retry?: () => void }) {
	return toast.error(message, {
		id: opts?.id ?? message,
		description: opts?.description,
		action: opts?.retry ? { label: "Retry", onClick: opts.retry } : undefined,
	});
}
