import type { WalletState } from "@/hosted/billing/contracts";

export function shouldShowX402Card(wallet: Pick<WalletState, "x402_enabled"> | undefined): boolean {
	return wallet?.x402_enabled === true;
}
