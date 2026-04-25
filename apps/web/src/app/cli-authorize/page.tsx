"use client";

import { useMutation, useQuery } from "@tanstack/react-query";
import { AlertCircle, CheckCircle2, Clock, Terminal, XCircle } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Skeleton } from "@/components/ui/skeleton";
import { ApiError, unwrap, useApi } from "@/lib/api";

interface DeviceLookup {
	user_code: string;
	client_label: string | null;
	status: "pending" | "approved" | "denied" | "expired" | "consumed";
	expires_at: string;
}

// `useSearchParams()` must sit under a Suspense boundary so Next.js can bail
// out of static prerender for this page (the URL `?code=…` only exists at
// request time). Without the boundary, `next build` errors out with
// "useSearchParams() should be wrapped in a suspense boundary".
export default function CliAuthorizePage() {
	return (
		<Suspense
			fallback={
				<Shell>
					<Skeleton className="h-32 w-full" />
				</Shell>
			}
		>
			<CliAuthorizeContent />
		</Suspense>
	);
}

function CliAuthorizeContent() {
	const params = useSearchParams();
	const code = params.get("code")?.toUpperCase().trim() ?? "";
	const api = useApi();
	const [terminalState, setTerminalState] = useState<"approved" | "denied" | null>(null);

	const lookup = useQuery({
		enabled: code.length > 0,
		queryKey: ["cli-authorize", code],
		queryFn: async (): Promise<DeviceLookup> =>
			unwrap(
				await api.GET("/api/cli/auth/lookup", {
					params: { query: { code } },
				}),
			) as DeviceLookup,
	});

	const approve = useMutation({
		mutationFn: async () => {
			const res = await api.POST("/api/cli/auth/approve", { body: { user_code: code } });
			unwrap(res);
		},
		onSuccess: () => setTerminalState("approved"),
	});

	const deny = useMutation({
		mutationFn: async () => {
			const res = await api.POST("/api/cli/auth/deny", { body: { user_code: code } });
			unwrap(res);
		},
		onSuccess: () => setTerminalState("denied"),
	});

	if (!code) {
		return (
			<Shell>
				<Alert variant="destructive">
					<AlertCircle />
					<AlertTitle>Missing authorization code</AlertTitle>
					<AlertDescription>
						Open this page through the link `clawdi auth login` printed in your terminal — it
						already includes the code.
					</AlertDescription>
				</Alert>
			</Shell>
		);
	}

	if (lookup.isLoading) {
		return (
			<Shell>
				<Skeleton className="h-32 w-full" />
			</Shell>
		);
	}

	if (lookup.error) {
		const status = lookup.error instanceof ApiError ? lookup.error.status : 0;
		const message =
			status === 404
				? "We don't recognize this authorization code. It may have expired — start over with `clawdi auth login`."
				: status === 410
					? "This authorization code has expired. Run `clawdi auth login` again to get a new one."
					: lookup.error instanceof Error
						? lookup.error.message
						: "Failed to load authorization request.";
		return (
			<Shell>
				<Alert variant="destructive">
					<AlertCircle />
					<AlertTitle>Can't load this request</AlertTitle>
					<AlertDescription>{message}</AlertDescription>
				</Alert>
			</Shell>
		);
	}

	const data = lookup.data;
	if (!data) return null;

	// Backend statuses we treat as "the CLI already moved on" — show a
	// terminal screen and stop offering buttons.
	const visibleStatus = terminalState ?? data.status;

	if (visibleStatus === "approved") {
		return (
			<Shell>
				<TerminalCard
					icon={<CheckCircle2 className="size-10 text-success" />}
					title="CLI authorized"
					body="Return to your terminal — the CLI should pick up the credentials within a couple of seconds."
				/>
			</Shell>
		);
	}

	if (visibleStatus === "denied") {
		return (
			<Shell>
				<TerminalCard
					icon={<XCircle className="size-10 text-destructive" />}
					title="Authorization denied"
					body="The CLI on the other side will see this and stop polling. Re-run `clawdi auth login` to start fresh."
				/>
			</Shell>
		);
	}

	if (visibleStatus === "expired" || visibleStatus === "consumed") {
		return (
			<Shell>
				<TerminalCard
					icon={<Clock className="size-10 text-muted-foreground" />}
					title="Code expired"
					body="Authorization codes are good for 10 minutes. Run `clawdi auth login` again to get a new one."
				/>
			</Shell>
		);
	}

	const expiresAt = new Date(data.expires_at);
	const minutesLeft = Math.max(0, Math.round((expiresAt.getTime() - Date.now()) / 60000));

	return (
		<Shell>
			<Card>
				<CardHeader className="space-y-1">
					<CardTitle className="flex items-center gap-2">
						<Terminal className="size-5" />
						Authorize the Clawdi CLI
					</CardTitle>
					<p className="text-sm text-muted-foreground">
						A CLI on this machine is asking to act on behalf of your account. Confirm the code below
						matches what your terminal shows.
					</p>
				</CardHeader>
				<CardContent className="space-y-5">
					<div className="rounded-lg border bg-muted/30 p-4">
						<div className="text-xs uppercase tracking-wide text-muted-foreground">Code</div>
						<div className="mt-1 font-mono text-2xl font-semibold tracking-widest">
							{data.user_code}
						</div>
						{data.client_label ? (
							<div className="mt-3 text-sm text-muted-foreground">
								<span className="text-xs uppercase tracking-wide">Client</span>
								<div className="font-mono text-sm">{data.client_label}</div>
							</div>
						) : null}
						<div className="mt-3 text-xs text-muted-foreground">
							Expires in ~{minutesLeft} minute{minutesLeft === 1 ? "" : "s"}.
						</div>
					</div>

					<div className="flex items-center justify-end gap-2">
						<Button
							variant="ghost"
							onClick={() => deny.mutate()}
							disabled={deny.isPending || approve.isPending}
						>
							{deny.isPending ? "Denying…" : "Deny"}
						</Button>
						<Button onClick={() => approve.mutate()} disabled={approve.isPending || deny.isPending}>
							{approve.isPending ? "Authorizing…" : "Authorize"}
						</Button>
					</div>

					{(approve.error || deny.error) && (
						<Alert variant="destructive">
							<AlertCircle />
							<AlertDescription>
								{(approve.error || deny.error) instanceof Error
									? (approve.error || deny.error)?.message
									: "Action failed. Please retry."}
							</AlertDescription>
						</Alert>
					)}
				</CardContent>
			</Card>
		</Shell>
	);
}

function Shell({ children }: { children: React.ReactNode }) {
	return (
		<main className="flex min-h-screen items-center justify-center bg-background p-6">
			<div className="w-full max-w-md space-y-4">
				{children}
				<div className="text-center text-xs text-muted-foreground">
					<Link href="/" className="hover:underline">
						← Back to dashboard
					</Link>
				</div>
			</div>
		</main>
	);
}

function TerminalCard({
	icon,
	title,
	body,
}: {
	icon: React.ReactNode;
	title: string;
	body: string;
}) {
	return (
		<Card>
			<CardContent className="flex flex-col items-center gap-3 py-10 text-center">
				{icon}
				<h2 className="text-lg font-semibold">{title}</h2>
				<p className="max-w-xs text-sm text-muted-foreground">{body}</p>
			</CardContent>
		</Card>
	);
}
