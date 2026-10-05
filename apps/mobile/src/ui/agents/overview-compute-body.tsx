import { overviewComputeBodyClasses as styles } from "@clawdi/shared/ui";
import { formatMemoryMib } from "@clawdi/shared/view";
import type { ReactNode } from "react";
import { Skeleton } from "../skeleton";
import { WebText, WebView } from "../web-layout";
export function OverviewComputeBody({
	planLabel,
	resources,
	subscription,
	date,
	action,
	loading = false,
}: {
	planLabel?: string;
	resources?: { vcpu: number; memory_mib: number; disk_gib: number };
	subscription?: { label: string | null; value: ReactNode } | null;
	date?: { label: string | null; value: ReactNode } | null;
	action?: ReactNode;
	loading?: boolean;
}) {
	const facts = [subscription, date].filter((fact) => fact !== null && fact !== undefined);
	return (
		<WebView recipe={styles.spaceY}>
			<WebText recipe={styles.textSmTextMutedForeground}>
				{loading ? <Skeleton className="h-4 w-32" /> : planLabel}
			</WebText>
			<WebView recipe={styles.flexFlexWrapGapXGapY} className="flex-row">
				{resources ? (
					<WebText recipe={styles.flexFlexWrapGapXGapY}>
						{resources.vcpu} vCPU · {formatMemoryMib(resources.memory_mib)} RAM ·{" "}
						{resources.disk_gib} GiB storage
					</WebText>
				) : loading ? (
					<Skeleton className="h-4 w-48" />
				) : null}
			</WebView>
			<WebView recipe={styles.spaceYTextXsTextMutedForeground}>
				{facts.map((fact, index) => (
					<WebView
						key={fact.label ?? index}
						recipe={styles.flexItemsCenterGap}
						className="flex-row"
					>
						<WebText recipe={styles.spaceYTextXsTextMutedForeground}>{fact.label}</WebText>
						<WebText recipe={styles.spaceYTextXsTextMutedForeground} className="flex-1">
							{fact.value}
						</WebText>
					</WebView>
				))}
			</WebView>
			{action ? <WebView recipe={styles.flexFlexWrapJustifyEndGap}>{action}</WebView> : null}
		</WebView>
	);
}
