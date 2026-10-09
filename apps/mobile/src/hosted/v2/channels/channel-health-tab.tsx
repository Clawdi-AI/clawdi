import type { components } from "@clawdi/shared/api";
import {
	ENTITY_CARD_BASE,
	statusBadgeIconClassName,
	channelDetailPageClasses as styles,
} from "@clawdi/shared/ui";
import {
	agentSurfaceCopy,
	CHANNEL_HEALTH_COPY,
	channelHealthErrorSummary,
	channelHealthReportedAt,
	channelHealthStats,
	channelHealthSummary,
	channelHealthTone,
	nativeTransportSummary,
} from "@clawdi/shared/view";
import CircleAlert from "lucide-react-native/icons/circle-alert";
import CircleCheck from "lucide-react-native/icons/circle-check";
import TriangleAlert from "lucide-react-native/icons/triangle-alert";
import { EmptyState } from "@/components/empty-state";
import { SectionLabel } from "@/components/section-label";
import { Icon } from "@/components/ui/icon";
import { StatusBadge } from "@/components/ui/status-badge";
import { Text } from "@/components/ui/text";
import { AppView } from "@/components/ui/view";
import { WebText, WebView, webBoth } from "@/components/ui/web-layout";

type Health = components["schemas"]["ChannelHealthItemResponse"];

/** Web HealthTab presentation; the parent retains account-fenced channel reads. */
export function ChannelHealthTab({ health }: { health?: Health }) {
	if (!health)
		return (
			<EmptyState
				title={CHANNEL_HEALTH_COPY.unavailable}
				description={CHANNEL_HEALTH_COPY.unavailableDescription}
			/>
		);
	const summary = channelHealthSummary(health);
	const stats = channelHealthStats(health);
	const error = channelHealthErrorSummary(health);
	const transport = health.native_transport
		? nativeTransportSummary(health.native_transport)
		: null;
	const tone = channelHealthTone(health.health_status);
	const icon =
		tone === "success" ? CircleCheck : tone === "destructive" ? CircleAlert : TriangleAlert;
	return (
		<WebView recipe={styles.skeletonContent}>
			<WebView recipe={styles.activityHeading} className="flex-row">
				<StatusBadge status={tone} accessibilityLabel={`${summary.label}. ${summary.detail}`}>
					<Icon as={icon} className={webBoth(statusBadgeIconClassName)} />
					<Text>{summary.label}</Text>
				</StatusBadge>
				<WebText recipe={styles.healthMeta} className="flex-1">
					{summary.detail}
				</WebText>
			</WebView>
			<WebView recipe={styles.healthStats}>
				{[stats.slice(0, 2), stats.slice(2)].map((row, index) => (
					<WebView key={index} recipe={styles.healthStats} className="flex-row">
						{row.map((stat) => (
							<WebView key={stat.label} recipe={ENTITY_CARD_BASE} className="flex-1">
								<WebText recipe={styles.healthStatValue}>{stat.value}</WebText>
								<WebText recipe={styles.healthMeta}>{stat.label}</WebText>
							</WebView>
						))}
					</WebView>
				))}
			</WebView>
			{error ? (
				<WebView recipe={`${ENTITY_CARD_BASE} ${styles.healthError}`}>
					<WebView recipe={styles.errorTitle} className="flex-row">
						<Icon as={TriangleAlert} className={webBoth(styles.actionIcon)} />
						<Text>{CHANNEL_HEALTH_COPY.lastError}</Text>
					</WebView>
					<WebText recipe={styles.errorDescription}>{error}</WebText>
					<WebText recipe={styles.healthMeta}>
						{channelHealthReportedAt(health.last_error_at)}
					</WebText>
				</WebView>
			) : null}
			{transport ? (
				<WebView recipe={ENTITY_CARD_BASE}>
					<SectionLabel className={webBoth(styles.transportHeading)}>
						{CHANNEL_HEALTH_COPY.transport}
					</SectionLabel>
					<WebView recipe={styles.transportStats}>
						{[
							{ label: agentSurfaceCopy.status, value: transport.status },
							{ label: CHANNEL_HEALTH_COPY.connection, value: transport.connection },
							{ label: CHANNEL_HEALTH_COPY.delivery, value: transport.delivery },
						].map((row) => (
							<AppView key={row.label}>
								<WebText recipe={styles.healthMeta}>{row.label}</WebText>
								<WebText recipe={styles.transportValue}>{row.value}</WebText>
							</AppView>
						))}
					</WebView>
				</WebView>
			) : null}
		</WebView>
	);
}
