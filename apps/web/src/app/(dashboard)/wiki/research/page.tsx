import { redirect } from "next/navigation";

// Deep Research moved into the merged /wiki/chat surface (mode pill).
// This route stays for stale links.
export default function ResearchRedirect() {
	redirect("/wiki/chat");
}
