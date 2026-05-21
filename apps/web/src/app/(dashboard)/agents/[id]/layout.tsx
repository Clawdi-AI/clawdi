import { pageMetadata } from "@/app/page-metadata";

export const metadata = pageMetadata(
	"Agent",
	"Manage a connected agent, installed skills, Projects, and sync status.",
);

export default function AgentDetailLayout({ children }: { children: React.ReactNode }) {
	return children;
}
