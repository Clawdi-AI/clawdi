import { pageMetadata } from "@/app/page-metadata";

export const metadata = pageMetadata(
	"Project",
	"Review a Project, its resources, access, sharing, and agent usage.",
);

export default function ProjectDetailLayout({ children }: { children: React.ReactNode }) {
	return children;
}
