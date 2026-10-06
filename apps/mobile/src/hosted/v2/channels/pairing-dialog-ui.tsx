import {
	type ChannelPairing,
	verifiedDiscordInstallUrl,
	verifiedDiscordPairingCommand,
} from "@clawdi/shared/api";
import { pairingQr } from "@clawdi/shared/qr";
import { channelFormClasses } from "@clawdi/shared/ui";
import { channelDetailCopy as copy, pairCodeExpiryLabel, providerMeta } from "@clawdi/shared/view";
import { useEffect, useState } from "react";
import { ActionButton } from "@/components/dashboard/controls";
import { QrImage } from "@/components/ui/qr-image";
import { Tabs, TabsList, TabsTrigger } from "@/components/ui/tabs";
import { Text } from "@/components/ui/text";
import { WebText, WebView, webText } from "@/components/ui/web-layout";

/** Presentation only. The route controller owns validation, expiry and secret lifetime. */
export function ChannelPairingView({
	provider,
	identity,
	pairing,
	link,
	busy,
	open,
}: {
	provider: string;
	identity: string;
	pairing: ChannelPairing;
	link: string | null;
	busy: boolean;
	open: (url: string) => void;
}) {
	const [path, setPath] = useState("server");
	const [now, setNow] = useState(Date.now());
	useEffect(() => {
		const timer = setInterval(() => setNow(Date.now()), 1000);
		return () => clearInterval(timer);
	}, []);
	const server = verifiedDiscordInstallUrl(pairing.discord_install_url);
	const dm = verifiedDiscordInstallUrl(pairing.discord_user_install_url);
	const url = provider === "discord" ? (path === "dm" ? dm : server) : link;
	const qr = url ? pairingQr(url) : null;
	const command =
		provider !== "discord" || verifiedDiscordPairingCommand(pairing.pairing_command, pairing.code);
	return (
		<WebView recipe={channelFormClasses.pairingBody} className="gap-4">
			<Text className={webText(channelFormClasses.pairingIdentity)}>{identity}</Text>
			<WebText recipe={channelFormClasses.pairingDescription}>{copy.pairDescription}</WebText>
			{provider === "discord" ? (
				<Tabs value={path} onValueChange={setPath}>
					<TabsList>
						<TabsTrigger value="server">{copy.server}</TabsTrigger>
						{dm ? <TabsTrigger value="dm">{copy.directMessage}</TabsTrigger> : null}
					</TabsList>
				</Tabs>
			) : null}
			{qr ? (
				<WebView recipe={channelFormClasses.pairingQr}>
					<QrImage
						matrix={qr}
						label={`${providerMeta(provider).label} pairing QR code`}
						size={176}
					/>
				</WebView>
			) : null}
			<Text className={webText(channelFormClasses.pairingExpiry)}>
				{pairCodeExpiryLabel(pairing.expires_at, now)}
			</Text>
			{url ? (
				<>
					<ActionButton
						label={
							provider === "discord"
								? path === "dm"
									? copy.addToApps
									: copy.addToServer
								: `${copy.openProvider} ${providerMeta(provider).label}`
						}
						disabled={busy}
						onPress={() => open(url)}
					/>
					<Text selectable className={webText(channelFormClasses.pairingCode)}>
						{url}
					</Text>
				</>
			) : null}
			{command ? (
				<WebView recipe={channelFormClasses.pairingInstructions}>
					<Text className="text-sm font-medium">{copy.pairManually}</Text>
					<Text className="text-sm">
						{provider === "telegram"
							? `${copy.sendTo} ${identity}:`
							: provider === "whatsapp"
								? copy.sendWhatsApp
								: path === "dm"
									? copy.discordDm
									: copy.discordServer}
					</Text>
					<Text selectable className={webText(channelFormClasses.pairingCode)}>
						{pairing.pairing_command}
					</Text>
					{provider === "discord" ? (
						<Text selectable className="font-mono text-sm">
							{pairing.code}
						</Text>
					) : null}
				</WebView>
			) : null}
		</WebView>
	);
}
