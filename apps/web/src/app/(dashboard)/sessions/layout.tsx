import { pageMetadata } from "@/app/page-metadata";

export const metadata = pageMetadata(
	"Sessions",
	"Review synced AI agent sessions, activity, tokens, and share controls.",
);

export default function SessionsLayout({ children }: { children: React.ReactNode }) {
	return children;
}
