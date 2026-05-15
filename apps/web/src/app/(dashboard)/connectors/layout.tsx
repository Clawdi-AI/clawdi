import { pageMetadata } from "@/app/page-metadata";

export const metadata = pageMetadata(
	"Connectors",
	"Connect external apps and services so agents can use them through Clawdi.",
);

export default function ConnectorsLayout({ children }: { children: React.ReactNode }) {
	return children;
}
