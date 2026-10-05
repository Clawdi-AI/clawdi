import {
	agentIconClasses,
	agentLabelClasses,
	computeSubscriptionCardClasses as styles,
} from "@clawdi/shared/ui";
import {
	agentIdentity,
	computeSubscriptionCardView,
	computeSubscriptionLifecycle,
} from "@clawdi/shared/view";
import type { ReactNode } from "react";
import type { Subscription } from "../../features/billing/helpers";
import { useI18n } from "../../i18n";
import { AgentFrameworkIcon } from "../agent-framework-icon";
import { EntityCardChassis } from "../entity-card";
import { StatusBadge } from "../status-badge";
import { Text } from "../text";
import { WebText, WebView, webView } from "../web-layout";

export function ComputeSubscriptionCard({
	item,
	actions,
	notice,
}: {
	item: Subscription;
	actions?: ReactNode;
	notice?: ReactNode;
}) {
	const t = useI18n();
	const identity = agentIdentity({ name: item.agent_name, agent_type: null });
	const lifecycle = computeSubscriptionLifecycle(item);
	const view = computeSubscriptionCardView({
		status: { label: lifecycle.badgeLabel, tone: lifecycle.badgeTone },
		planSlug: item.plan_slug,
		fundingSource:
			item.subscription_kind === "included_basic"
				? "included"
				: (item.funding_source ?? "unavailable"),
		priceCents: item.price_cents,
		currency: item.currency,
		billingTermMonths: item.billing_term_months,
		scheduleVerb: lifecycle.dateVerb,
		scheduleAt: lifecycle.dateAt,
	});
	return (
		<EntityCardChassis variant="compact" className={webView(styles.notices)}>
			<WebView recipe={styles.heading} className="flex-row">
				<WebText recipe={styles.planName}>{view.plan}</WebText>
				<StatusBadge status={view.status.tone} withDot>
					<Text>{view.status.label}</Text>
				</StatusBadge>
			</WebView>
			<WebView recipe={styles.meta} className="flex-row">
				{view.commercialFacts.map((fact) => (
					<WebText
						key={fact.label}
						recipe={styles.metaText}
						className={fact.emphasis ? styles.noticeStrong : undefined}
					>
						{fact.value}
					</WebText>
				))}
			</WebView>
			{item.agent_name ? (
				<WebView recipe={styles.footer} className="flex-row">
					<WebText recipe={styles.hint}>{t("billingParity.usedBy")}</WebText>
					<WebView recipe={styles.identity}>
						<WebView recipe={agentLabelClasses.root}>
							<AgentFrameworkIcon
								agent={null}
								pixelSize={24}
								boxClassName={webView(`${agentIconClasses.medium} ${agentIconClasses.rounded}`)}
								fallbackIconClassName={agentIconClasses.mediumFallback}
							/>
							<WebView recipe={agentLabelClasses.copy}>
								<WebText recipe={`${agentLabelClasses.name} ${agentLabelClasses.nameBySize.md}`}>
									{identity.primaryLabel}
								</WebText>
								{identity.secondaryLabel ? (
									<WebText
										recipe={`${agentLabelClasses.subtitle} ${agentLabelClasses.subtitleGapBySize.md}`}
									>
										{identity.secondaryLabel}
									</WebText>
								) : null}
							</WebView>
						</WebView>
					</WebView>
				</WebView>
			) : null}
			{notice ? <WebView recipe={styles.price}>{notice}</WebView> : null}
			{actions ? (
				<WebView recipe={styles.actions} className="flex-row">
					{actions}
				</WebView>
			) : null}
		</EntityCardChassis>
	);
}
