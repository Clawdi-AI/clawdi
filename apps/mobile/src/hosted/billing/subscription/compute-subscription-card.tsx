import {
	agentIconFallbackClasses,
	agentIconRadiusClasses,
	agentIconSizeClasses,
	agentLabelClasses,
	computeSubscriptionCardClasses as styles,
} from "@clawdi/shared/ui";
import {
	agentIdentity,
	computeSubscriptionCardView,
	computeSubscriptionLifecycle,
} from "@clawdi/shared/view";
import type { ReactNode } from "react";
import { AgentFrameworkIcon } from "@/components/agent-framework-icon";
import { EntityCardChassis } from "@/components/entity-card";
import { StatusBadge } from "@/components/ui/status-badge";
import { Text } from "@/components/ui/text";
import { WebText, WebView, webView } from "@/components/ui/web-layout";
import { useDashboardAgents } from "@/hooks/use-dashboard-agents";
import type { Subscription } from "@/hosted/billing/format";
import { creditPrice } from "@/hosted/billing/store/store-presentation";
import { useI18n } from "@/lib/i18n";
import { useStoreSurfaces } from "@/platform/store/store-provider";

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
	const { creditUnits } = useStoreSurfaces();
	const inventory = useDashboardAgents();
	const deployment = inventory.inventory.data?.find(
		(entry) => entry.resource.id === item.deployment_id,
	);
	const agent = inventory.tiles.find((tile) => tile.id === deployment?.agent_id);
	const identity = agentIdentity({ name: item.agent_name, agent_type: agent?.agentType ?? null });
	const lifecycle = computeSubscriptionLifecycle(item);
	const view = computeSubscriptionCardView({
		status: { label: lifecycle.badgeLabel, tone: lifecycle.badgeTone },
		planSlug: item.plan_slug,
		fundingSource:
			item.subscription_kind === "included_basic"
				? "included"
				: item.funding_source === "store"
					? "unavailable"
					: (item.funding_source ?? "unavailable"),
		priceCents: item.price_cents,
		currency: item.currency,
		billingTermMonths: item.billing_term_months,
		scheduleVerb: lifecycle.dateVerb,
		scheduleAt: lifecycle.dateAt,
		...(creditUnits
			? {
					formatPrice: (cents: number, currency: string) =>
						creditPrice({ price_cents: cents, currency }, t("store.credits")) ??
						t("billing.unknown"),
				}
			: {}),
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
								agent={agent?.agentType}
								pixelSize={24}
								boxClassName={webView(
									`${agentIconSizeClasses.md} ${agentIconRadiusClasses.rounded}`,
								)}
								fallbackIconClassName={agentIconFallbackClasses.md}
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
