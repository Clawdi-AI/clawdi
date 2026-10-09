import { walletDebitEquationClasses as styles } from "@clawdi/shared/ui";
import {
	walletDebitEquationCopy as copy,
	type WalletDebitSummary,
	walletDebitEquationLabel,
} from "@clawdi/shared/view";
import { WebText, WebView } from "@/components/ui/web-layout";

function EquationValue({ label, amount }: { label: string; amount: string }) {
	return (
		<WebView recipe={styles.value}>
			<WebText recipe={styles.label}>{label}</WebText>
			<WebText recipe={styles.amount} numberOfLines={1}>
				{amount}
			</WebText>
		</WebView>
	);
}

/** Web's balance − debit = after equation; `format` renders USD or store credits. */
export function WalletDebitEquation({
	debit,
	format,
}: {
	debit: WalletDebitSummary;
	format: (usd: string) => string;
}) {
	return (
		<WebView
			recipe={styles.root}
			accessible
			accessibilityLabel={walletDebitEquationLabel(debit, format)}
		>
			<EquationValue label={copy.balanceBefore} amount={format(debit.balanceBeforeUsd)} />
			<WebText recipe={styles.operator} importantForAccessibility="no">
				−
			</WebText>
			<EquationValue label={copy.exactDebit} amount={format(debit.debitAmountUsd)} />
			<WebText recipe={styles.operator} importantForAccessibility="no">
				=
			</WebText>
			<EquationValue label={copy.balanceAfter} amount={format(debit.balanceAfterUsd)} />
		</WebView>
	);
}
