import { pageMetadata } from "@/app/page-metadata";

export const metadata = pageMetadata(
	"Skills",
	"Install, sync, and manage portable agent skills across connected environments.",
);

export default function SkillsLayout({ children }: { children: React.ReactNode }) {
	return children;
}
