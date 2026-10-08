import { authPageClasses } from "@clawdi/shared/ui";
import { SignUp } from "@clerk/tanstack-react-start";
import { env } from "@/lib/env";
import { DevAuthBypassPage } from "./dev-auth-bypass-page";

const isDevAuthBypass = env.VITE_DEV_AUTH_BYPASS;

export default function SignUpPage() {
	if (isDevAuthBypass) return <DevAuthBypassPage mode="sign-up" />;

	return (
		<main className={authPageClasses.main}>
			<SignUp />
		</main>
	);
}
