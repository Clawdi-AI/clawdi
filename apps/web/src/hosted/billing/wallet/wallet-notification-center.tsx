"use client";

import { useRouter } from "@tanstack/react-router";
import { NotificationCenter } from "@/components/notification-center";
import { walletNotificationCenterItems } from "@/hosted/billing/wallet/wallet-notifications";
import { useWalletSnapshot } from "@/hosted/billing/wallet/wallet-query";
import { headerWalletBalanceApplicable } from "@/hosted/global-wallet-balance";
import { useProductAccess } from "@/lib/product-access";

export function HostedWalletNotificationCenter({
	existingCloudDeploymentCount,
}: {
	existingCloudDeploymentCount: number | null;
}) {
	const router = useRouter();
	const access = useProductAccess();
	const applicable = headerWalletBalanceApplicable({
		canCreateCloudAgents: access.canCreateCloudAgents,
		existingCloudDeploymentCount,
	});
	const wallet = useWalletSnapshot({ enabled: applicable });
	const openWallet = () => {
		void router.navigate({
			to: ".",
			search: (current) => ({ ...current, settings: "billing-wallet" }),
			hash: true,
			replace: true,
			resetScroll: false,
		});
	};

	return (
		<div data-hosted="true" className="contents">
			<NotificationCenter
				actionRequired={applicable ? walletNotificationCenterItems(wallet.data) : []}
				onActionRequired={openWallet}
			/>
		</div>
	);
}

export default HostedWalletNotificationCenter;
