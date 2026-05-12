"use client";

import { useAuth, useUser } from "@clerk/nextjs";
import { useMutation, useQuery } from "@tanstack/react-query";
import {
	AlertCircle,
	CheckCircle2,
	FileText,
	KeyRound,
	Lock,
	LogIn,
	ShieldCheck,
	Sparkles,
} from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { env } from "@/lib/env";

/**
 * Public share-link landing page (Spec §6 Web Surface).
 *
 * Flow:
 *   1. Anonymous preview — call GET /api/share/{token} unauthenticated,
 *      render scope name, owner display+handle, skill/vault counts.
 *   2. Two CTAs:
 *      - "Sign in to join" → upgrades to a permanent ScopeMembership
 *        (the dashboard then lists this scope alongside the user's own).
 *      - "Copy CLI command" → `clawdi inbox accept <url>`, for users who
 *        prefer the anonymous-then-upgrade path on the CLI.
 *   3. Already signed in → POST /api/share/{token}/upgrade and redirect
 *      to /skills (or /vault if vault-only).
 *
 * Auth handling:
 *   - Preview endpoint is anonymous.
 *   - Upgrade endpoint is Clerk-authenticated.
 *   - Vault content is NEVER previewed here; only counts. Spec §10.
 */

interface SharePreview {
	scope_id: string;
	scope_name: string;
	owner_display: string;
	owner_handle: string;
	skill_count: number;
	vault_count: number;
	vault_locked: boolean;
}

interface ShareUpgradeResponse {
	scope_id: string;
	resolved_owner_handle: string;
	membership_id: string;
}

const API_URL = env.NEXT_PUBLIC_API_URL;

function buildLandingUrl(token: string): string {
	// Use window.location so the copy-CLI command points to wherever this
	// page is actually being served from — same-origin, no env coupling.
	if (typeof window === "undefined") return `/share/${token}`;
	return `${window.location.origin}/share/${token}`;
}

async function fetchPreview(token: string): Promise<SharePreview> {
	// Spec § 4.4 / API §: GET /api/share/{token}/preview — side-effect free,
	// does NOT increment redeem_count. The /redeem POST is reserved for
	// explicit-accept CTA, which on the web is the upgrade button below
	// (logged-in path skips redeem entirely → straight to membership).
	const r = await fetch(`${API_URL}/api/share/${token}/preview`, {
		method: "GET",
	});
	if (r.status === 404) throw new ShareError("not_found");
	if (r.status === 410) throw new ShareError("revoked");
	if (!r.ok) throw new ShareError("unknown", r.status);
	return r.json();
}

async function upgradeShare(token: string, bearer: string): Promise<ShareUpgradeResponse> {
	const r = await fetch(`${API_URL}/api/share/${token}/upgrade`, {
		method: "POST",
		headers: { Authorization: `Bearer ${bearer}` },
	});
	if (r.status === 404) throw new ShareError("not_found");
	if (r.status === 410) throw new ShareError("revoked");
	if (r.status === 409) {
		const body = (await r.json().catch(() => ({}))) as {
			detail?: { error?: string };
		};
		if (body?.detail?.error === "already_owner") {
			throw new ShareError("already_owner");
		}
		throw new ShareError("already_member");
	}
	if (!r.ok) throw new ShareError("unknown", r.status);
	return r.json();
}

type ShareErrorCode = "not_found" | "revoked" | "already_member" | "already_owner" | "unknown";

class ShareError extends Error {
	constructor(
		public code: ShareErrorCode,
		public status?: number,
	) {
		super(code);
	}
}

export default function SharePage() {
	const params = useParams<{ token: string }>();
	const token = params.token;
	const router = useRouter();
	const { isSignedIn, getToken } = useAuth();
	const { user } = useUser();

	const preview = useQuery({
		queryKey: ["share-preview", token],
		queryFn: () => fetchPreview(token),
		retry: false,
	});

	const upgrade = useMutation({
		mutationFn: async () => {
			const bearer = await getToken();
			if (!bearer) throw new ShareError("unknown");
			return upgradeShare(token, bearer);
		},
		onSuccess: () => {
			// Sharee lands on their dashboard with the shared scope already
			// listed. Skills first if there are any; vault otherwise.
			const hasSkills = (preview.data?.skill_count ?? 0) > 0;
			router.push(hasSkills ? "/skills" : "/vault");
		},
	});

	if (preview.isLoading) {
		return (
			<Shell>
				<Skeleton className="h-64 w-full" />
			</Shell>
		);
	}

	if (preview.error) {
		return <ErrorView error={preview.error} />;
	}

	const data = preview.data;
	if (!data) return null;

	const isOwner =
		user?.publicMetadata?.scope_owner_handle === data.owner_handle ||
		(upgrade.error instanceof ShareError && upgrade.error.code === "already_owner");

	return (
		<Shell>
			<Card>
				<CardHeader>
					<div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
						<Sparkles className="size-4" />
						You've been invited to a shared scope
					</div>
					<CardTitle className="mt-2 text-2xl">{data.scope_name}</CardTitle>
					<p className="text-sm text-muted-foreground">
						Shared by <span className="font-medium text-foreground">{data.owner_display}</span>{" "}
						<span className="text-xs font-mono">@{data.owner_handle}</span>
					</p>
				</CardHeader>
				<CardContent className="space-y-6">
					<div className="grid grid-cols-2 gap-3">
						<ContentTile
							icon={<FileText className="size-5" />}
							label="Skills"
							count={data.skill_count}
							hint="Readable on any device"
						/>
						<ContentTile
							icon={<Lock className="size-5" />}
							label="Vault secrets"
							count={data.vault_count}
							hint="Sign in to unlock"
							muted={data.vault_count === 0}
						/>
					</div>

					<Separator />

					{upgrade.isSuccess ? (
						<Alert>
							<CheckCircle2 />
							<AlertTitle>You're in.</AlertTitle>
							<AlertDescription>
								Added to your workspace as a read-only scope — you'll see {data.owner_display}'s
								skills alongside your own. Redirecting…
							</AlertDescription>
						</Alert>
					) : isOwner ? (
						<Alert>
							<ShieldCheck />
							<AlertTitle>This is your own scope.</AlertTitle>
							<AlertDescription>You don't need to accept it — it's already yours.</AlertDescription>
						</Alert>
					) : isSignedIn ? (
						<div className="space-y-3">
							<Button
								onClick={() => upgrade.mutate()}
								disabled={upgrade.isPending}
								className="w-full"
								size="lg"
							>
								<CheckCircle2 className="mr-2 size-4" />
								{upgrade.isPending ? "Joining…" : "Accept and add to my dashboard"}
							</Button>
							<p className="text-xs text-muted-foreground">
								You'll join as a <Badge variant="secondary">viewer</Badge> — read-only access to
								skills{data.vault_count > 0 ? " and vault secrets" : ""}. {data.owner_display} keeps
								full control.
							</p>
							{upgrade.error instanceof ShareError && upgrade.error.code === "already_member" ? (
								<Alert>
									<CheckCircle2 />
									<AlertDescription>
										You're already a member — check your dashboard.
									</AlertDescription>
								</Alert>
							) : upgrade.error ? (
								<Alert variant="destructive">
									<AlertCircle />
									<AlertDescription>
										{describeError((upgrade.error as ShareError).code)}
									</AlertDescription>
								</Alert>
							) : null}
						</div>
					) : (
						<div className="space-y-4">
							<Link href={`/sign-in?redirect_url=/share/${token}`}>
								<Button className="w-full" size="lg">
									<LogIn className="mr-2 size-4" />
									Sign in to accept
								</Button>
							</Link>
							<div className="rounded-lg border bg-muted/30 p-4">
								<div className="flex items-center gap-2 text-sm font-medium">
									<KeyRound className="size-4" />
									Prefer the CLI?
								</div>
								<p className="mt-1 text-xs text-muted-foreground">
									Run this in your terminal — skills sync immediately; sign in later to unlock vault
									secrets and add it permanently.
								</p>
								<CopyableCommand command={`clawdi inbox accept ${buildLandingUrl(token)}`} />
							</div>
						</div>
					)}
				</CardContent>
			</Card>
			<p className="text-center text-xs text-muted-foreground">
				Shared scopes never grant write access. The owner can revoke this link anytime.
			</p>
		</Shell>
	);
}

function ContentTile({
	icon,
	label,
	count,
	hint,
	muted,
}: {
	icon: React.ReactNode;
	label: string;
	count: number;
	hint: string;
	muted?: boolean;
}) {
	return (
		<div className={`rounded-lg border p-4 ${muted ? "bg-muted/20 text-muted-foreground" : ""}`}>
			<div className="flex items-center gap-2 text-sm">
				{icon}
				<span className="font-medium">{label}</span>
			</div>
			<div className="mt-2 text-2xl font-semibold">{count}</div>
			<div className="text-xs text-muted-foreground">{hint}</div>
		</div>
	);
}

function CopyableCommand({ command }: { command: string }) {
	return (
		<div className="mt-2 flex items-center gap-2">
			<code className="flex-1 truncate rounded border bg-background px-2 py-1 font-mono text-xs">
				$ {command}
			</code>
			<Button
				variant="outline"
				size="sm"
				onClick={() => {
					if (typeof navigator !== "undefined" && navigator.clipboard) {
						navigator.clipboard.writeText(command).catch(() => {});
					}
				}}
			>
				Copy
			</Button>
		</div>
	);
}

function ErrorView({ error }: { error: unknown }) {
	if (!(error instanceof ShareError)) {
		return (
			<Shell>
				<Alert variant="destructive">
					<AlertCircle />
					<AlertTitle>Something went wrong</AlertTitle>
					<AlertDescription>
						{error instanceof Error ? error.message : "Failed to load share link."}
					</AlertDescription>
				</Alert>
			</Shell>
		);
	}
	return (
		<Shell>
			<Alert variant="destructive">
				<AlertCircle />
				<AlertTitle>{titleForError(error.code)}</AlertTitle>
				<AlertDescription>{describeError(error.code)}</AlertDescription>
			</Alert>
		</Shell>
	);
}

function titleForError(code: ShareErrorCode): string {
	switch (code) {
		case "not_found":
			return "Share link not found";
		case "revoked":
			return "Share link revoked";
		case "already_member":
			return "Already a member";
		case "already_owner":
			return "That's your own scope";
		default:
			return "Couldn't load this share";
	}
}

function describeError(code: ShareErrorCode): string {
	switch (code) {
		case "not_found":
			return "This link doesn't exist. Ask the owner to send you a fresh one.";
		case "revoked":
			return "The owner revoked this link. Ask them to send you a new one.";
		case "already_member":
			return "You already accepted this share — find it on your dashboard.";
		case "already_owner":
			return "You own this scope — nothing to accept.";
		default:
			return "Please try again. If the problem persists, ping the owner.";
	}
}

function Shell({ children }: { children: React.ReactNode }) {
	return (
		<main className="flex min-h-screen items-center justify-center bg-background p-6">
			<div className="w-full max-w-md space-y-4">{children}</div>
		</main>
	);
}
