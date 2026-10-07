import { Redirect } from "expo-router";

const DevAccountRoute: typeof import("@/pages/dev/account-page").default = __DEV__
	? require("@/pages/dev/account-page").default
	: () => <Redirect href="/" />;

export default DevAccountRoute;
