import { overviewComputeBodyClasses as styles } from "@clawdi/shared/ui";
import { overviewComputeSummaryCopy as copy, overviewComputeSpecs } from "@clawdi/shared/view";
import type { ReactNode } from "react";
import { Skeleton } from "../skeleton";
import { WebText, WebView, webView } from "../web-layout";
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
		<WebView recipe={styles.spaceY}>
			<WebText recipe={styles.textSmTextMutedForeground}>
				{loading ? (
					<Skeleton className={webView(styles.hLhWMaxWFull)} style={{ height: 20 }} />
				) : (
					planLabel
				)}
			</WebText>
			<WebView
				recipe={styles.flexFlexWrapGapXGapY}
				className="flex-row"
				accessibilityLabel={copy.resources}
			>
				{specs.map((item, index) => (
					<WebView
						key={item.key}
						recipe={styles.flexItemsCenterGap}
						className="flex-row"
						accessibilityLabel={item.label}
					>
						{index > 0 ? <WebText recipe={styles.textSmTextMutedForeground}>·</WebText> : null}
						{loading ? (
							<Skeleton
								className={webView(`${styles.specSkeleton} ${styles[`${item.key}Skeleton`]}`)}
								style={{ height: 16 }}
							/>
						) : (
							<WebText recipe={styles.flexFlexWrapGapXGapY}>{item.value}</WebText>
						)}
					</WebView>
				))}
			</WebView>
			{facts.length ? (
				<WebView recipe={styles.spaceYTextXsTextMutedForeground}>
					{facts.map((fact, index) => (
						<WebView
							key={fact.label ?? index}
							recipe={`${styles.commercialRow} ${loading ? styles.commercialLoadingRow : ""}`}
							className="flex-row"
						>
							{fact.label ? (
								loading ? (
									<Skeleton
										className={webView(styles.relativeHLhMaxWFull)}
										style={{ height: 16, minWidth: 88 }}
									/>
								) : (
									<WebText recipe={styles.commercialLabel}>{fact.label}</WebText>
								)
							) : null}
							{loading ? (
								<Skeleton className={webView(styles.hLhWMaxWFull2)} style={{ height: 16 }} />
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
			{action ? <WebView recipe={styles.flexFlexWrapJustifyEndGap}>{action}</WebView> : null}
		</WebView>
	);
}
