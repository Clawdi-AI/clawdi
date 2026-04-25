import { redirect } from "next/navigation";

/**
 * Agents are surfaced through the Overview page (Agents card) — there's no
 * dedicated `/agents` list view by design. Without this redirect, deep
 * links from the breadcrumb's "Agents" segment 404. Send the user to the
 * Overview where the agent grid lives.
 */
export default function AgentsIndexPage(): never {
	redirect("/");
}
