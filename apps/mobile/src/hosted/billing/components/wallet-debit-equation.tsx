import { walletDebitEquationClasses as styles } from "@clawdi/shared/ui";
import {
	walletDebitEquationCopy as copy,
	formatUsdExact,
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

/** Web's balance − debit = after equation. */
export function WalletDebitEquation({ debit }: { debit: WalletDebitSummary }) {
	return (
		<WebView recipe={styles.root} accessible accessibilityLabel={walletDebitEquationLabel(debit)}>
			<EquationValue label={copy.balanceBefore} amount={formatUsdExact(debit.balanceBeforeUsd)} />
			<WebText recipe={styles.operator} importantForAccessibility="no">
				−
			</WebText>
			<EquationValue label={copy.exactDebit} amount={formatUsdExact(debit.debitAmountUsd)} />
			<WebText recipe={styles.operator} importantForAccessibility="no">
				=
			</WebText>
			<EquationValue label={copy.balanceAfter} amount={formatUsdExact(debit.balanceAfterUsd)} />
		</WebView>
	);
}
