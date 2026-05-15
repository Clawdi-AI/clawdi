import { pageMetadata } from "@/app/page-metadata";

export const metadata = pageMetadata(
	"Connector",
	"Configure an external app connector and its authentication state.",
);

export default function ConnectorDetailLayout({ children }: { children: React.ReactNode }) {
	return children;
}
