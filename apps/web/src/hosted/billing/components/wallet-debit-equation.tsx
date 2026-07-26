import { ApiErrorPanel } from "@/components/api-error-panel";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Spinner } from "@/components/ui/spinner";
import { billingErrorNormalizer } from "@/hosted/billing/errors";
import { formatUsdExact } from "@/hosted/billing/format";

export function trustworthyWalletBalanceUsd({
	balanceUsd,
	error,
	isFetching,
}: {
	balanceUsd: string | null;
	error: unknown;
	isFetching: boolean;
}): string | null {
	return error || isFetching ? null : balanceUsd;
}

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
	balanceError,
	isBalanceFetching = false,
	onRetryBalance,
}: {
	balanceBeforeUsd: string | null;
	debitAmountUsd: string;
	balanceAfterUsd: string | null;
	balanceError?: unknown;
	isBalanceFetching?: boolean;
	onRetryBalance?: () => void;
}) {
	if (balanceError) {
		return (
			<ApiErrorPanel
				normalizer={billingErrorNormalizer}
				error={balanceError}
				title="Couldn't load your Wallet balance"
				onRetry={onRetryBalance}
			/>
		);
	}
	if (isBalanceFetching || balanceBeforeUsd === null || balanceAfterUsd === null) {
		return (
			<Alert data-hosted="true">
				<Spinner />
				<AlertTitle>Refreshing Wallet balance</AlertTitle>
				<AlertDescription>
					The balance equation will appear after a fresh Wallet read completes.
				</AlertDescription>
			</Alert>
		);
	}

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
