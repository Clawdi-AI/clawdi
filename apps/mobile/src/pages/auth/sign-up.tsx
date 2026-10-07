import { AuthView } from "@clerk/expo/native";

export default function SignUpPage() {
	return <AuthView mode="signUp" isDismissible={false} />;
}
