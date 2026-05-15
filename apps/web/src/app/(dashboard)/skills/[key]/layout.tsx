import { pageMetadata } from "@/app/page-metadata";

export const metadata = pageMetadata(
	"Skill",
	"Review and edit an installed Clawdi skill and its target agent environments.",
);

export default function SkillDetailLayout({ children }: { children: React.ReactNode }) {
	return children;
}
