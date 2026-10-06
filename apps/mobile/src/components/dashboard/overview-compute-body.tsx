import { overviewComputeBodyClasses as styles } from "@clawdi/shared/ui";
import { overviewComputeSummaryCopy as copy, overviewComputeSpecs } from "@clawdi/shared/view";
import type { ReactNode } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { WebText, WebView, webView } from "@/components/ui/web-layout";
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
	const specs = overviewComputeSpecs(resources);
	const facts = loading
		? [
				{ label: copy.subscription, value: null },
				{ label: copy.nextRenewal, value: null },
			]
		: [subscription, date].filter((fact) => fact !== null && fact !== undefined);
	return (
		<WebView recipe={styles.root}>
			<WebText recipe={styles.plan}>
				{loading ? (
					<Skeleton className={webView(styles.planSkeleton)} style={{ height: 20 }} />
				) : (
					planLabel
				)}
			</WebText>
			<WebView recipe={styles.specs} className="flex-row" accessibilityLabel={copy.resources}>
				{specs.map((item, index) => (
					<WebView
						key={item.key}
						recipe={styles.specValue}
						className="flex-row"
						accessibilityLabel={item.label}
					>
						{index > 0 ? <WebText recipe={styles.plan}>·</WebText> : null}
						{loading ? (
							<Skeleton
								className={webView(`${styles.specSkeleton} ${styles[`${item.key}Skeleton`]}`)}
								style={{ height: 16 }}
							/>
						) : (
							<WebText recipe={styles.specs}>{item.value}</WebText>
						)}
					</WebView>
				))}
			</WebView>
			{facts.length ? (
				<WebView recipe={styles.commercial}>
					{facts.map((fact, index) => (
						<WebView
							key={fact.label ?? index}
							recipe={`${styles.commercialRow} ${loading ? styles.commercialLoadingRow : ""}`}
							className="flex-row"
						>
							{fact.label ? (
								loading ? (
									<Skeleton
										className={webView(styles.commercialLabelSkeleton)}
										style={{ height: 16, minWidth: 88 }}
									/>
								) : (
									<WebText recipe={styles.commercialLabel}>{fact.label}</WebText>
								)
							) : null}
							{loading ? (
								<Skeleton
									className={webView(styles.commercialStatusSkeleton)}
									style={{ height: 16 }}
								/>
							) : (
								<WebText
									recipe={fact.label ? styles.commercialValue : styles.commercialAccess}
									className="flex-1"
								>
									{fact.value}
								</WebText>
							)}
						</WebView>
					))}
				</WebView>
			) : null}
			{action ? <WebView recipe={styles.actions}>{action}</WebView> : null}
		</WebView>
	);
}
