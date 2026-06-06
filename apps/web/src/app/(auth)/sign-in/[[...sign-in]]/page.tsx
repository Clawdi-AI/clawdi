import { SignIn } from "@clerk/nextjs";
import { DevAuthBypassPage } from "../../dev-auth-bypass-page";

const isDevAuthBypass =
	process.env.NEXT_PUBLIC_DEV_AUTH_BYPASS === "true" && process.env.NODE_ENV !== "production";

export default function SignInPage() {
	if (isDevAuthBypass) return <DevAuthBypassPage mode="sign-in" />;

	return (
		<main className="flex min-h-dvh items-center justify-center">
			<SignIn />
		</main>
	);
}
