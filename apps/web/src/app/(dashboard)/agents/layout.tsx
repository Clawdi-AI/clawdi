import { pageMetadata } from "@/app/page-metadata";

export const metadata = pageMetadata("Agents", "View connected agents and their sync status.");

export default function AgentsLayout({ children }: { children: React.ReactNode }) {
	return children;
}
