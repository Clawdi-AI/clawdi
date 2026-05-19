import { SignUp } from "@clerk/nextjs";
import { DevAuthBypassPage } from "../../dev-auth-bypass-page";

const isDevAuthBypass =
	process.env.NEXT_PUBLIC_DEV_AUTH_BYPASS === "true" && process.env.NODE_ENV !== "production";

export default function SignUpPage() {
	if (isDevAuthBypass) return <DevAuthBypassPage mode="sign-up" />;

	return (
		<main className="flex min-h-screen items-center justify-center">
			<SignUp />
		</main>
	);
}
