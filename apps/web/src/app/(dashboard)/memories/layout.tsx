import { pageMetadata } from "@/app/page-metadata";

export const metadata = pageMetadata(
	"Memories",
	"Manage shared AI agent memories and memory provider settings.",
);

export default function MemoriesLayout({ children }: { children: React.ReactNode }) {
	return children;
}
