"use client";

import { type ReactNode, useRef, useState } from "react";
import type { ChannelAgentLink } from "@/hosted/v2/channels/channel-types";
import { useChannelBindings } from "@/hosted/v2/channels/channels-hooks";
import { DiscordPairDialog } from "@/hosted/v2/channels/discord-pair-dialog";
import { TelegramPairDialog } from "@/hosted/v2/channels/telegram-pair-dialog";
import { WhatsAppPairDialog } from "@/hosted/v2/channels/whatsapp-pair-dialog";
import { toastApiError } from "@/lib/api";

type PairingState = {
	link: ChannelAgentLink;
	baselineBindingCount: number;
	open: boolean;
};

/** Shared pairing state used after a new link and from an existing linked-Agent row. */
export function useChannelPairingFlow(accountId: string) {
	const [pairing, setPairing] = useState<PairingState | null>(null);
	const [openingLinkId, setOpeningLinkId] = useState<string | null>(null);
	const openingRef = useRef(false);
	const bindings = useChannelBindings(accountId, pairing !== null);

	const openPairing = async (link: ChannelAgentLink) => {
		if (openingRef.current) return false;
		openingRef.current = true;
		setOpeningLinkId(link.id);
		try {
			const result = await bindings.refetch();
			if (result.error) {
				toastApiError("Couldn't load paired chats")(result.error);
				return false;
			}
			setPairing({
				link,
				baselineBindingCount: (result.data ?? []).filter(
					(binding) => binding.agent_link_id === link.id,
				).length,
				open: true,
			});
			return true;
		} finally {
			openingRef.current = false;
			setOpeningLinkId(null);
		}
	};

	const bindingCount = pairing
		? (bindings.data ?? []).filter((binding) => binding.agent_link_id === pairing.link.id).length
		: 0;

	return {
		pairing,
		bindingCount,
		openingLinkId,
		openPairing,
		setOpen(open: boolean) {
			setPairing((current) => (current ? { ...current, open } : current));
		},
		completeClose() {
			setPairing((current) => (current?.open === false ? null : current));
		},
	};
}

export function ChannelPairingDialog({
	accountId,
	provider,
	channelName,
	flow,
}: {
	accountId: string;
	provider: string;
	channelName: string;
	flow: ReturnType<typeof useChannelPairingFlow>;
}) {
	const { pairing } = flow;
	if (!pairing) return null;

	const commonProps = {
		open: pairing.open,
		onOpenChange: flow.setOpen,
		onCloseComplete: flow.completeClose,
		agentId: pairing.link.agent_id,
		accountId,
		agentLinkId: pairing.link.id,
		channelName,
		bindingCount: flow.bindingCount,
		baselineBindingCount: pairing.baselineBindingCount,
	};

	let dialog: ReactNode;
	switch (provider) {
		case "telegram":
			dialog = <TelegramPairDialog {...commonProps} />;
			break;
		case "discord":
			dialog = <DiscordPairDialog {...commonProps} />;
			break;
		case "whatsapp":
			dialog = <WhatsAppPairDialog {...commonProps} />;
			break;
		default:
			return null;
	}
	return (
		<span data-hosted="true" data-v2="true" className="contents">
			{dialog}
		</span>
	);
}
