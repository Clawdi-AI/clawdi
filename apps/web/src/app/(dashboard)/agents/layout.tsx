import { pageMetadata } from "@/app/page-metadata";

export const metadata = pageMetadata(
	"Agents",
	"View connected agent environments and their sync status.",
);

export default function AgentsLayout({ children }: { children: React.ReactNode }) {
	return children;
}
