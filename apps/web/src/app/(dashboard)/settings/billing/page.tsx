import { redirect } from "next/navigation";

/** Billing index lands on the Wallet tab. */
export default function BillingIndexPage(): never {
	redirect("/settings/billing/wallet");
}
