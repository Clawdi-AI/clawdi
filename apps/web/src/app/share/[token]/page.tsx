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
import { toast } from "sonner";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card";
import { Separator } from "@/components/ui/separator";
import { Skeleton } from "@/components/ui/skeleton";
import { env } from "@/lib/env";

/**
 * Public project-share landing page.
 *
 * Flow:
 *   1. Anonymous preview — call GET /api/share/{token}/preview,
 *      render project name, owner display+handle, skill/vault counts.
 *   2. Sign-in CTA upgrades to a permanent ProjectMembership.
 *   3. Agent bindings are explicit and handled separately after accept.
 */

interface SharePreview {
	project_id: string;
	project_name: string;
	owner_display: string;
	owner_handle: string;
	skill_count: number;
	vault_count: number;
	vault_locked: boolean;
}

interface ShareUpgradeResponse {
	membership_id: string;
	project_id: string;
	role: string;
	joined_via: string;
	joined_at: string;
	resolved_owner_handle: string;
	bound_agent_ids?: string[];
}

const API_URL = env.NEXT_PUBLIC_API_URL;

function buildLandingUrl(token: string): string {
	if (typeof window === "undefined") return `/share/${token}`;
	return `${window.location.origin}/share/${token}`;
}

async function fetchPreview(token: string): Promise<SharePreview> {
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
		headers: { Authorization: `Bearer ${bearer}`, "Content-Type": "application/json" },
		body: JSON.stringify({}),
	});
	if (r.status === 404) throw new ShareError("not_found");
	if (r.status === 410) throw new ShareError("revoked");
	if (r.status === 409) {
		const body = (await r.json().catch(() => ({}))) as { detail?: { error?: string } };
		if (body?.detail?.error === "already_owner") throw new ShareError("already_owner");
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

	const profileOwnerHandle =
		(user?.publicMetadata?.project_owner_handle as string | undefined) ??
		(user?.publicMetadata?.owner_handle as string | undefined);
	const isOwner =
		profileOwnerHandle === data.owner_handle ||
		(upgrade.error instanceof ShareError && upgrade.error.code === "already_owner");

	return (
		<Shell>
			<Card>
				<CardHeader>
					<div className="flex items-center gap-2 text-xs uppercase tracking-wide text-muted-foreground">
						<Sparkles className="size-4" />
						You've been invited to a shared project
					</div>
					<CardTitle className="mt-2 text-2xl">{data.project_name}</CardTitle>
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
							label="Vault keys"
							count={data.vault_count}
							hint="Key names only"
							muted={data.vault_count === 0}
						/>
					</div>

					<Separator />

					{upgrade.isSuccess ? (
						<Alert>
							<CheckCircle2 />
							<AlertTitle>You're in.</AlertTitle>
							<AlertDescription>
								Added to your projects as viewer access. Agent binding is separate. Redirecting…
							</AlertDescription>
						</Alert>
					) : isOwner ? (
						<Alert>
							<ShieldCheck />
							<AlertTitle>This is your own project.</AlertTitle>
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
								{upgrade.isPending ? "Joining…" : "Accept project access"}
							</Button>
							<p className="text-xs text-muted-foreground">
								You'll join as a <Badge variant="secondary">viewer</Badge> — read-only access to
								skills{data.vault_count > 0 ? " and vault key references" : ""}. Agent bindings are
								managed separately.
							</p>
							{upgrade.error instanceof ShareError && upgrade.error.code === "already_member" ? (
								<Alert>
									<CheckCircle2 />
									<AlertDescription>
										You're already a member — check your dashboard and bind this project to agents
										as needed.
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
									Run this in your terminal — skills sync immediately; sign in later to keep the
									membership across devices.
								</p>
								<CopyableCommand command={`clawdi inbox accept ${buildLandingUrl(token)}`} />
							</div>
						</div>
					)}
				</CardContent>
			</Card>
			<p className="text-center text-xs text-muted-foreground">
				Shared projects never grant write access. The owner can revoke this link anytime.
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
		<div className="mt-2 flex flex-col gap-2 sm:flex-row sm:items-center">
			<code className="flex-1 truncate rounded border bg-background px-2 py-1 font-mono text-xs">
				$ {command}
			</code>
			<Button
				variant="outline"
				size="sm"
				aria-label="Copy CLI accept command"
				onClick={() => {
					if (typeof navigator !== "undefined" && navigator.clipboard) {
						navigator.clipboard
							.writeText(command)
							.then(() => toast.success("Command copied"))
							.catch(() => toast.error("Couldn't copy — select the command and copy manually"));
					} else {
						toast.error("Couldn't copy — select the command and copy manually");
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
			return "That's your own project";
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
			return "You own this project — nothing to accept.";
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
