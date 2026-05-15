import { pageMetadata } from "@/app/page-metadata";

export const metadata = pageMetadata(
	"Memory",
	"Inspect a stored agent memory, source metadata, and deletion controls.",
);

export default function MemoryDetailLayout({ children }: { children: React.ReactNode }) {
	return children;
}
