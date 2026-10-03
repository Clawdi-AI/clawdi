import { expect, test } from "bun:test";
import { emptySignupDetails, signupDetailFields, signupDetailsRequest } from "./signup-details";

test("signup updates only server-requested details and never truncates or trims passwords", () => {
	const values = {
		...emptySignupDetails(),
		first_name: " Ada ",
		email_address: "already@verified.test",
		password: " passphrase ",
	};
	expect(signupDetailsRequest(["first_name", "password"], values)).toEqual({
		firstName: "Ada",
		password: " passphrase ",
	});
	expect(signupDetailFields(["legal_accepted"])).toBeNull();
	expect(() => signupDetailsRequest(["legal_accepted"], values)).toThrow();
	expect(() => signupDetailsRequest(["protect_check"], values)).toThrow();
});
test("either-identifier requirements select one valid identity without guessing country codes", () => {
	const values = { ...emptySignupDetails(), email_address_or_phone_number: "+14155552671" };
	expect(signupDetailsRequest(["email_address_or_phone_number"], values)).toEqual({
		phoneNumber: "+14155552671",
	});
	expect(
		signupDetailsRequest(["email_address_or_phone_number"], {
			...values,
			email_address_or_phone_number: "a@example.test",
		}),
	).toEqual({ emailAddress: "a@example.test" });
	expect(() =>
		signupDetailsRequest(["phone_number"], { ...values, phone_number: "4155552671" }),
	).toThrow();
});
