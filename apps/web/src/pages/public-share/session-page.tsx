import { publicSessionClasses } from "@clawdi/shared/ui";
import { publicSessionScopeLabel, relativeTime } from "@clawdi/shared/view";
import { Link } from "@tanstack/react-router";
import { Clock, MessageSquare } from "lucide-react";
import { ClawdiLogo } from "@/components/clawdi-logo";
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
import type { PublicShareResult } from "./session-page.functions";

type PublicSharePageResult = Exclude<PublicShareResult, { kind: "not-found" }>;

export default function PublicSharePage({ result }: { result: PublicSharePageResult }) {
	if (result.kind === "unauthorized") return <SignInToView />;
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
	const scopeLabel = publicSessionScopeLabel(share.scope);

	return (
		<>
			<ShareHeader />
			<div className={`${CENTERED_PAGE_WIDTH_CLASS.page} ${publicSessionClasses.page}`}>
				<div className={publicSessionClasses.heading}>
					<div className={publicSessionClasses.body}>
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
					<p className={publicSessionClasses.empty}>This share has no readable content.</p>
				) : (
					<PublicSessionTimeline
						shareId={share.id}
						source={share.source}
						initialPage={messagesPage}
						agentType={share.agent_type}
					/>
				)}

				<footer className={publicSessionClasses.footer}>
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
		<div className={publicSessionClasses.gate}>
			<div className={publicSessionClasses.gateLabel}>Link turned off</div>
			<h1 className={publicSessionClasses.gateTitle}>This session share is no longer available</h1>
			<p className={publicSessionClasses.gateBody}>
				The owner revoked this link. Ask them to create a new share if you still need access.
			</p>
			<Link to="/" className={publicSessionClasses.gateLink}>
				Go to Clawdi
			</Link>
		</div>
	);
}

function ShareHeader() {
	return (
		<header className={publicSessionClasses.header}>
			<div className={publicSessionClasses.headerRow}>
				<Link to="/" className={publicSessionClasses.brand}>
					<ClawdiLogo width={28} height={28} className={publicSessionClasses.brandImage} />
					<span className={publicSessionClasses.brandName}>Clawdi</span>
				</Link>
				<ShareHeaderUser />
			</div>
		</header>
	);
}
