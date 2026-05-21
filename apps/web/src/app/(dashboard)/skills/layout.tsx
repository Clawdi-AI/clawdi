import { pageMetadata } from "@/app/page-metadata";

export const metadata = pageMetadata(
	"Skills",
	"Pick a Project, then install and manage the skills saved there.",
);

export default function SkillsLayout({ children }: { children: React.ReactNode }) {
	return children;
}
