import { pageMetadata } from "@/app/page-metadata";

export const metadata = pageMetadata(
	"Session",
	"Inspect a synced AI agent session, message history, metadata, and sharing options.",
);

export default function SessionDetailLayout({ children }: { children: React.ReactNode }) {
	return children;
}
