import { redirect } from "next/navigation";

/** `/settings` has no content of its own — land on the first sub-page. */
export default function SettingsIndexPage(): never {
	redirect("/settings/general");
}
