import { pageMetadata } from "@/app/page-metadata";

export const metadata = pageMetadata(
	"Projects",
	"Create shareable Projects and review automatically managed Projects.",
);

export default function ProjectsLayout({ children }: { children: React.ReactNode }) {
	return children;
}
