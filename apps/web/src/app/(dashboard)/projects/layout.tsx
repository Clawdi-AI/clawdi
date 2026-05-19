import { pageMetadata } from "@/app/page-metadata";

export const metadata = pageMetadata(
	"Projects",
	"Create Custom Projects and review managed Global and Agent Projects.",
);

export default function ProjectsLayout({ children }: { children: React.ReactNode }) {
	return children;
}
