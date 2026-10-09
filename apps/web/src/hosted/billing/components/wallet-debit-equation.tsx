import { walletDebitEquationClasses as styles } from "@clawdi/shared/ui";
import { walletDebitEquationCopy as copy, walletDebitEquationLabel } from "@clawdi/shared/view";
import { formatUsdExact } from "@/hosted/billing/format";

function EquationValue({ label, amountUsd }: { label: string; amountUsd: string }) {
	return (
		<dl className={styles.value}>
			<dt className={styles.label}>{label}</dt>
			<dd className={styles.amount}>{formatUsdExact(amountUsd)}</dd>
		</dl>
	);
}

export function WalletDebitEquation({
	balanceBeforeUsd,
	debitAmountUsd,
	balanceAfterUsd,
}: {
	balanceBeforeUsd: string;
	debitAmountUsd: string;
	balanceAfterUsd: string;
}) {
	const accessibleEquation = walletDebitEquationLabel({
		balanceBeforeUsd,
		debitAmountUsd,
		balanceAfterUsd,
	});
	return (
		<figure data-hosted="true" className={styles.root} data-testid="wallet-debit-equation">
			<figcaption className="sr-only">{accessibleEquation}</figcaption>
			<EquationValue label={copy.balanceBefore} amountUsd={balanceBeforeUsd} />
			<span className={styles.operator} aria-hidden>
				−
			</span>
			<EquationValue label={copy.exactDebit} amountUsd={debitAmountUsd} />
			<span className={styles.operator} aria-hidden>
				=
			</span>
			<EquationValue label={copy.balanceAfter} amountUsd={balanceAfterUsd} />
		</figure>
	);
}
