import { agentLabelClasses, computeSubscriptionCardClasses as styles } from "@clawdi/shared/ui";
import {
	agentIdentity,
	billingCopy,
	type ComputeSubscriptionCardView,
	type ComputeSubscriptionIdentity,
} from "@clawdi/shared/view";
import CircleCheck from "lucide-react-native/icons/circle-check";
import UserRoundX from "lucide-react-native/icons/user-round-x";
import type { ReactNode } from "react";
import { AgentIcon } from "@/components/dashboard/agent-icon";
import { EntityCardChassis } from "@/components/entity-card";
import { Icon } from "@/components/ui/icon";
import { StatusBadge } from "@/components/ui/status-badge";
import { Text } from "@/components/ui/text";
import { AppPressable } from "@/components/ui/view";
import { WebText, WebView, webView } from "@/components/ui/web-layout";

function SubscriptionIdentity({
	identity,
	onOpenAgent,
}: {
	identity: ComputeSubscriptionIdentity;
	onOpenAgent?: () => void;
}) {
	if (identity.kind !== "agent") {
		const available = identity.kind === "available";
		return (
			<WebView
				recipe={available ? styles.includedIdentity : styles.orphanIdentity}
				className="flex-row"
			>
				<WebView recipe={available ? styles.includedIconTile : styles.orphanIconTile}>
					<Icon as={available ? CircleCheck : UserRoundX} className={styles.icon} />
				</WebView>
				<WebText recipe={styles.identityLabel} numberOfLines={1} className="flex-1">
					{identity.label}
				</WebText>
			</WebView>
		);
	}
	const label = agentIdentity({ name: identity.name, agent_type: identity.agentType });
	const body = (
		<WebView recipe={agentLabelClasses.root}>
			<AgentIcon agent={identity.agentType} avatarUrl={identity.avatarUrl} size="md" />
			<WebView recipe={agentLabelClasses.copy}>
				<WebText recipe={`${agentLabelClasses.name} ${agentLabelClasses.nameBySize.md}`}>
					{label.primaryLabel}
				</WebText>
				{label.secondaryLabel ? (
					<WebText
						recipe={`${agentLabelClasses.subtitle} ${agentLabelClasses.subtitleGapBySize.md}`}
					>
						{label.secondaryLabel}
					</WebText>
				) : null}
			</WebView>
		</WebView>
	);
	return onOpenAgent ? (
		<AppPressable accessibilityRole="link" className="active:opacity-80" onPress={onOpenAgent}>
			{body}
		</AppPressable>
	) : (
		body
	);
}

/** Web's compute subscription card: plan, status, commercial facts, user, notices, actions. */
export function ComputeSubscriptionCard({
	view,
	identity,
	onOpenAgent,
	badges,
	notice,
	actions,
}: {
	view: ComputeSubscriptionCardView;
	identity?: ComputeSubscriptionIdentity;
	/** Web links the agent to its settings. */
	onOpenAgent?: () => void;
	badges?: ReactNode;
	notice?: ReactNode;
	actions?: ReactNode;
}) {
	return (
		<EntityCardChassis variant="compact" className={webView(styles.notices)}>
			<WebView recipe={styles.heading} className="flex-row">
				<WebText recipe={styles.planName}>{view.plan}</WebText>
				<WebView recipe={styles.badges} className="flex-row">
					<StatusBadge status={view.status.tone} withDot>
						<Text>{view.status.label}</Text>
					</StatusBadge>
					{badges}
				</WebView>
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
			{identity ? (
				<WebView recipe={styles.footer} className="flex-row">
					{identity.kind === "agent" ? (
						<WebText recipe={styles.hint}>{billingCopy.usedBy}</WebText>
					) : null}
					<WebView recipe={styles.identity}>
						<SubscriptionIdentity identity={identity} onOpenAgent={onOpenAgent} />
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
