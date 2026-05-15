import { pageMetadata } from "@/app/page-metadata";

export const metadata = pageMetadata("Authorize CLI", "Authorize the Clawdi CLI on this machine.");

export default function CliAuthorizeLayout({ children }: { children: React.ReactNode }) {
	return children;
}
