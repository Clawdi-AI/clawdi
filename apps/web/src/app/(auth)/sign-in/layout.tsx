import { pageMetadata } from "@/app/page-metadata";

export const metadata = pageMetadata("Sign in", "Sign in to Clawdi to manage your AI agents.");

export default function SignInLayout({ children }: { children: React.ReactNode }) {
	return children;
}
