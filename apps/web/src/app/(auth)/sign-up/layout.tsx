import { pageMetadata } from "@/app/page-metadata";

export const metadata = pageMetadata(
	"Sign up",
	"Create a Clawdi Cloud account to connect and manage AI agents.",
);

export default function SignUpLayout({ children }: { children: React.ReactNode }) {
	return children;
}
