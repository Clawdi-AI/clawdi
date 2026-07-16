import { formatCents, formatExactCredits } from "@/hosted/billing/format";

function EquationValue({
	label,
	credits,
	secondary,
}: {
	label: string;
	credits: string;
	secondary?: string;
}) {
	return (
		<dl className="min-w-0 flex-1 rounded-md bg-muted/50 px-3 py-2">
			<dt className="text-xs text-muted-foreground">{label}</dt>
			<dd className="truncate font-medium tabular-nums">{formatExactCredits(credits)}</dd>
			{secondary ? (
				<dd className="text-xs text-muted-foreground tabular-nums">{secondary}</dd>
			) : null}
		</dl>
	);
}

export function WalletDebitEquation({
	balanceBeforeCredits,
	exactDebitCredits,
	exactDebitCents,
	balanceAfterCredits,
}: {
	balanceBeforeCredits: string;
	exactDebitCredits: string;
	exactDebitCents: number;
	balanceAfterCredits: string;
}) {
	const accessibleEquation = `${formatExactCredits(balanceBeforeCredits)} minus ${formatExactCredits(
		exactDebitCredits,
	)} equals ${formatExactCredits(balanceAfterCredits)}`;
	return (
		<figure
			data-hosted="true"
			className="flex flex-col gap-1.5 rounded-lg border p-3 text-sm sm:flex-row sm:items-center"
			data-testid="wallet-debit-equation"
		>
			<figcaption className="sr-only">{accessibleEquation}</figcaption>
			<EquationValue label="Balance before" credits={balanceBeforeCredits} />
			<span className="self-center text-muted-foreground" aria-hidden>
				−
			</span>
			<EquationValue
				label="Exact debit"
				credits={exactDebitCredits}
				secondary={formatCents(exactDebitCents)}
			/>
			<span className="self-center text-muted-foreground" aria-hidden>
				=
			</span>
			<EquationValue label="Balance after" credits={balanceAfterCredits} />
		</figure>
	);
}
