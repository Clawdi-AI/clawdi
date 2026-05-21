import { pageMetadata } from "@/app/page-metadata";

export const metadata = pageMetadata(
	"Skill",
	"Review and edit an installed Clawdi skill in its Project.",
);

export default function SkillDetailLayout({ children }: { children: React.ReactNode }) {
	return children;
}
