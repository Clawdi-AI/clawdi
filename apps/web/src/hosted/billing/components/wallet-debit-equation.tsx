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
		<div className="min-w-0 flex-1 rounded-md bg-muted/50 px-3 py-2">
			<div className="text-xs text-muted-foreground">{label}</div>
			<div className="truncate font-medium tabular-nums">{formatExactCredits(credits)}</div>
			{secondary ? (
				<div className="text-xs text-muted-foreground tabular-nums">{secondary}</div>
			) : null}
		</div>
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
	return (
		<fieldset
			className="flex flex-col gap-1.5 rounded-lg border p-3 text-sm sm:flex-row sm:items-center"
			aria-label={`${formatExactCredits(balanceBeforeCredits)} minus ${formatExactCredits(
				exactDebitCredits,
			)} equals ${formatExactCredits(balanceAfterCredits)}`}
			data-testid="wallet-debit-equation"
		>
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
		</fieldset>
	);
}
