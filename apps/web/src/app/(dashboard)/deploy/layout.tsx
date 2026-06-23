import { pageMetadata } from "@/app/page-metadata";

export const metadata = pageMetadata(
	"Deploy",
	"Deploy a hosted agent: pick a framework and a channel.",
);

export default function DeployLayout({ children }: { children: React.ReactNode }) {
	return children;
}
