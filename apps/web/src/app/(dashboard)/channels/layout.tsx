import { pageMetadata } from "@/app/page-metadata";

export const metadata = pageMetadata(
	"Channels",
	"Connect Telegram, Discord, WhatsApp, and iMessage to your agents.",
);

export default function ChannelsLayout({ children }: { children: React.ReactNode }) {
	return children;
}
