import { Link } from "@tanstack/react-router";
import { Clock, MessageSquare } from "lucide-react";
import { AgentInline } from "@/components/dashboard/agent-label";
import { DetailMeta, DetailStats, DetailTitle } from "@/components/detail/layout";
import { ModelBadge } from "@/components/meta/model-badge";
import { Stat } from "@/components/meta/stat";
import { CENTERED_PAGE_WIDTH_CLASS } from "@/components/page-width";
import { PublicSessionTimeline } from "@/components/sessions/public-session-timeline";
import { ShareHeaderUser } from "@/components/share/header-user";
import { NoAccess } from "@/components/share/no-access";
import { PublicShareControls } from "@/components/share/public-share-controls";
import { SignInToView } from "@/components/share/sign-in-to-view";
import { TimeTooltip } from "@/components/time-tooltip";
import { relativeTime } from "@/lib/utils";
import type { PublicShareResult } from "./session-page.functions";

type PublicSharePageResult = Exclude<PublicShareResult, { kind: "not-found" }>;

export default function PublicSharePage({
	id,
	result,
}: {
	id: string;
	result: PublicSharePageResult;
}) {
	if (result.kind === "unauthorized") return <SignInToView shareUrl={`/s/${id}`} />;
	if (result.kind === "forbidden") return <NoAccess />;
	if (result.kind === "expired") {
		return (
			<>
				<ShareHeader />
				<ExpiredShare />
			</>
		);
	}

	const { share, messagesPage } = result;
	const scopeLabel =
		share.scope === "response"
			? "Shared response"
			: share.scope === "through"
				? "Shared conversation excerpt"
				: "Shared conversation";

	return (
		<>
			<ShareHeader />
			<div className={`${CENTERED_PAGE_WIDTH_CLASS.page} space-y-5 px-4 py-6 lg:px-6`}>
				<div className="flex flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
					<div className="min-w-0 flex-1 space-y-2">
						<DetailTitle>{share.title}</DetailTitle>
						<DetailMeta>
							<AgentInline machineName={null} type={share.agent_type} />
							<span>·</span>
							<TimeTooltip value={share.started_at}>
								<span>Started {relativeTime(share.started_at)}</span>
							</TimeTooltip>
							<span>·</span>
							<span>{scopeLabel}</span>
						</DetailMeta>
					</div>
					<div className="sm:shrink-0">
						<PublicShareControls sessionId={share.id} />
					</div>
				</div>

				<DetailStats>
					<ModelBadge modelId={share.model} />
					<Stat icon={MessageSquare} label={`${share.message_count} messages`} />
					<Stat icon={Clock} label={`Shared ${relativeTime(share.created_at)}`} />
				</DetailStats>

				{messagesPage.items.length === 0 ? (
					<p className="text-sm text-muted-foreground">This share has no readable content.</p>
				) : (
					<PublicSessionTimeline
						shareId={share.id}
						source={share.source}
						initialPage={messagesPage}
						agentType={share.agent_type}
					/>
				)}

				<footer className="border-t pt-4 text-xs text-muted-foreground">
					Shared via{" "}
					<Link to="/" className="font-medium underline-offset-4 hover:underline">
						Clawdi
					</Link>
				</footer>
			</div>
		</>
	);
}

function ExpiredShare() {
	return (
		<div className="mx-auto flex min-h-[60vh] max-w-md flex-col items-center justify-center px-6 text-center">
			<div className="text-xs uppercase tracking-wide text-muted-foreground">Link turned off</div>
			<h1 className="mt-2 text-2xl font-semibold tracking-tight">
				This Session share is no longer available
			</h1>
			<p className="mt-3 text-sm text-muted-foreground">
				The owner revoked this link. Ask them to create a new share if you still need access.
			</p>
			<Link to="/" className="mt-6 text-sm font-medium underline-offset-4 hover:underline">
				Go to Clawdi
			</Link>
		</div>
	);
}

function ShareHeader() {
	return (
		<header className="sticky top-0 z-30 border-b bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
			<div className="flex items-center justify-between px-4 py-3 lg:px-6">
				<Link to="/" className="flex items-center gap-2 transition-opacity hover:opacity-80">
					<img
						src="/clawdi-logo-transparent.png"
						alt=""
						width={28}
						height={28}
						className="size-7 shrink-0 rounded-md"
					/>
					<span className="text-sm font-semibold tracking-tight">Clawdi</span>
				</Link>
				<ShareHeaderUser />
			</div>
		</header>
	);
}
