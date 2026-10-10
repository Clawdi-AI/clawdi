import { transactionsSectionClasses as transactions } from "@clawdi/shared/ui";
import {
	formatShortDate,
	transactionComputeDetails,
	transactionDocumentAction,
	transactionKindLabel,
	transactionPaymentSourceLabel,
	transactionSignedAmount,
	transactionStatusLabel,
	transactionStatusTone,
} from "@clawdi/shared/view";
import { openBrowserAsync } from "expo-web-browser";
import ExternalLink from "lucide-react-native/icons/external-link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { StatusBadge } from "@/components/ui/status-badge";
import { Text } from "@/components/ui/text";
import { WebText, WebView, webView } from "@/components/ui/web-layout";
import type { Transaction } from "@/hosted/billing/format";
import { signedCredits } from "@/hosted/billing/store/store-presentation";
import { useI18n } from "@/lib/i18n";
import { useAccountScope } from "@/platform/account-lifecycle";
import { useAuthAction } from "@/platform/auth/use-auth-action";
import { useStoreSurfaces } from "@/platform/store/store-provider";
import { useForegroundLease } from "@/platform/use-foreground-lease";

export function TransactionRow({ item }: { item: Transaction }) {
	const t = useI18n();
	const scope = useAccountScope();
	const action = useAuthAction(scope.identity);
	const capture = useForegroundLease();
	const surfaces = useStoreSurfaces();
	// Store builds never link to Stripe receipts or invoices.
	const document = surfaces.cardBilling ? transactionDocumentAction(item) : null;
	let documentUrl: string | null = null;
	try {
		const url = document ? new URL(document.url) : null;
		if (url?.protocol === "https:" && !url.username && !url.password) documentUrl = url.href;
	} catch {
		// Malformed document links remain visible but cannot open a browser.
	}
	const openDocument = () =>
		void action.run(async (current) => {
			if (!documentUrl || !current() || !scope.isCurrent() || !capture()()) return;
			await openBrowserAsync(documentUrl);
		});
	return (
		<WebView recipe={transactions.mobileRow} className="flex-row px-0">
			<WebView recipe={transactions.mobileCopy} className="flex-1">
				<WebText recipe={transactions.label}>{transactionKindLabel(item.kind)}</WebText>
				{transactionComputeDetails(item).map((detail) => (
					<WebText key={detail} recipe={transactions.reference}>
						{detail}
					</WebText>
				))}
				<WebView recipe={transactions.mobileHeading} className="flex-row">
					{item.funding ? (
						<Badge variant="outline">
							<Text>{transactionPaymentSourceLabel(item.funding)}</Text>
						</Badge>
					) : null}
					<StatusBadge status={transactionStatusTone(item.status)}>
						<Text>{transactionStatusLabel(item.status)}</Text>
					</StatusBadge>
					<WebText recipe={transactions.description}>{formatShortDate(item.occurred_at)}</WebText>
				</WebView>
				{document ? (
					<Button
						variant="link"
						size="xs"
						className={webView(transactions.inlineAction)}
						disabled={!documentUrl || action.busy}
						onPress={openDocument}
					>
						<Text>{document.label}</Text>
						<Icon as={ExternalLink} />
					</Button>
				) : null}
				{action.error ? (
					<WebText accessibilityRole="alert" recipe={transactions.description}>
						{t("account.actionFailed")}
					</WebText>
				) : null}
			</WebView>
			<WebText
				recipe={transactions.amount}
				className={item.direction === "credit" ? "text-success-muted-foreground" : undefined}
			>
				{surfaces.creditUnits
					? signedCredits(transactionSignedAmount(item), t("store.credits"))
					: transactionSignedAmount(item)}
			</WebText>
		</WebView>
	);
}

/** Native payments remain outside this read-only presentation. */
