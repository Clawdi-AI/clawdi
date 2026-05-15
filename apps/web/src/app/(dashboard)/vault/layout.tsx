import { pageMetadata } from "@/app/page-metadata";

export const metadata = pageMetadata(
	"Vault",
	"Store and manage encrypted secrets for AI agent commands and workflows.",
);

export default function VaultLayout({ children }: { children: React.ReactNode }) {
	return children;
}
