"use client";

import { Check, Copy } from "lucide-react";
import { QRCodeSVG } from "qrcode.react";
import type { ComponentProps, ReactNode } from "react";
import {
	DialogContent,
	DialogDescription,
	DialogFooter,
	DialogHeader,
	DialogTitle,
} from "@/components/ui/dialog";
import { Spinner } from "@/components/ui/spinner";
import { useCopyToClipboard } from "@/hooks/use-copy-to-clipboard";
import { cn } from "@/lib/utils";

export function PairingDialogContent({ children }: { children: ReactNode }) {
	return (
		<DialogContent
			data-hosted="true"
			data-v2="true"
			className="h-[min(40rem,calc(100dvh-2rem))] max-h-[calc(100dvh-2rem)] min-w-0 grid-rows-[auto_minmax(0,1fr)_auto] gap-4 overflow-hidden sm:h-auto sm:max-w-md"
		>
			{children}
		</DialogContent>
	);
}

export function PairingDialogHeader({
	title,
	identity,
	description,
	scope,
}: {
	title: string;
	identity: string;
	description: string;
	scope?: string;
}) {
	return (
		<DialogHeader>
			<DialogTitle>{title}</DialogTitle>
			<p className="min-w-0 truncate text-sm font-medium" title={identity}>
				{identity}
			</p>
			<DialogDescription>
				{scope ? <span className="block font-medium text-foreground">{scope}</span> : null}
				<span className={scope ? "mt-1 block" : undefined}>{description}</span>
			</DialogDescription>
		</DialogHeader>
	);
}

export function PairingDialogBody({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			className={cn(
				"min-h-0 min-w-0 break-words overflow-y-auto overscroll-contain pr-1 [overflow-wrap:anywhere]",
				className,
			)}
			{...props}
		/>
	);
}

export function PairingDialogFooter({ className, ...props }: ComponentProps<typeof DialogFooter>) {
	return <DialogFooter className={cn("border-t pt-4", className)} {...props} />;
}

export function PairingLoading({ children }: { children: ReactNode }) {
	return (
		<div
			role="status"
			className="flex min-h-64 flex-col items-center justify-center gap-3 text-muted-foreground"
		>
			<Spinner className="size-5" />
			<p>{children}</p>
		</div>
	);
}

export function PairingNotice({ title, children }: { title: string; children: ReactNode }) {
	return (
		<div role="alert" className="rounded-lg border border-warning/40 bg-muted/20 p-4">
			<p className="text-sm font-medium">{title}</p>
			<p className="mt-1 text-xs text-muted-foreground">{children}</p>
		</div>
	);
}

export function PairingQrCode({ value, label }: { value: string; label: string }) {
	return (
		<div className="flex justify-center">
			<div className="max-w-full rounded-md border bg-white p-3 shadow-sm">
				<QRCodeSVG
					value={value}
					size={192}
					className="h-auto w-full max-w-44 sm:max-w-48"
					role="img"
					aria-label={label}
				/>
			</div>
		</div>
	);
}

export function PairingExpiry({
	children,
	expired = false,
}: {
	children: ReactNode;
	expired?: boolean;
}) {
	return (
		<p
			role="status"
			className={cn(
				"text-center text-sm font-medium",
				expired ? "text-destructive" : "text-muted-foreground",
			)}
		>
			{children}
		</p>
	);
}

export function PairingInstructionPanel({ className, ...props }: ComponentProps<"div">) {
	return (
		<div
			className={cn("space-y-2 rounded-lg border bg-muted/20 p-3 text-sm", className)}
			{...props}
		/>
	);
}

export function CopyablePairingCode({
	value,
	label,
	variant = "block",
}: {
	value: string;
	label: string;
	variant?: "inline" | "block";
}) {
	const { copied, copy } = useCopyToClipboard({
		success: false,
		error: `Couldn't copy ${label}`,
	});
	const actionLabel = copied ? `${label} copied` : `Copy ${label}`;

	return (
		<button
			type="button"
			onClick={() => void copy(value)}
			className={cn(
				"min-w-0 max-w-full items-center gap-2 rounded-md border bg-background font-mono text-xs text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
				variant === "inline"
					? "inline-flex px-1.5 py-0.5 align-baseline"
					: "flex w-full justify-between p-3 text-left",
			)}
			aria-label={actionLabel}
			title={actionLabel}
		>
			<code className={cn("min-w-0", variant === "block" ? "break-all" : "whitespace-nowrap")}>
				{value}
			</code>
			<span className="inline-flex shrink-0 items-center gap-1 font-sans text-muted-foreground">
				{variant === "block" ? <span aria-hidden="true">{copied ? "Copied" : "Copy"}</span> : null}
				{copied ? (
					<Check className="size-3.5" aria-hidden="true" />
				) : (
					<Copy className="size-3.5" aria-hidden="true" />
				)}
			</span>
			<span className="sr-only" aria-live="polite">
				{copied ? `${label} copied` : ""}
			</span>
		</button>
	);
}
