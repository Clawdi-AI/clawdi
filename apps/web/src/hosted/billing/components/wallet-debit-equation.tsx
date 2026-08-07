import { formatUsdExact } from "@/hosted/billing/format";

function EquationValue({ label, amountUsd }: { label: string; amountUsd: string }) {
	return (
		<dl className="min-w-0 flex-1 rounded-md bg-muted/50 px-3 py-2">
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd className="truncate font-medium tabular-nums">{formatUsdExact(amountUsd)}</dd>
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
	const accessibleEquation = `${formatUsdExact(balanceBeforeUsd)} minus ${formatUsdExact(
		debitAmountUsd,
	)} equals ${formatUsdExact(balanceAfterUsd)}`;
	return (
		<figure
			data-hosted="true"
			className="flex flex-col gap-1.5 rounded-lg border p-3 text-sm sm:flex-row sm:items-center"
			data-testid="wallet-debit-equation"
		>
			<figcaption className="sr-only">{accessibleEquation}</figcaption>
			<EquationValue label="Balance before" amountUsd={balanceBeforeUsd} />
			<span className="self-center text-muted-foreground" aria-hidden>
				−
			</span>
			<EquationValue label="Exact debit" amountUsd={debitAmountUsd} />
			<span className="self-center text-muted-foreground" aria-hidden>
				=
			</span>
			<EquationValue label="Balance after" amountUsd={balanceAfterUsd} />
		</figure>
	);
}
