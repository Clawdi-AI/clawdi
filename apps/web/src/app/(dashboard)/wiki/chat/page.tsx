import { redirect } from "next/navigation";

// Chat is now the default /wiki view; this route stays only for any
// stale links that pre-date the restructure.
export default function ChatRedirect() {
	redirect("/wiki");
}
