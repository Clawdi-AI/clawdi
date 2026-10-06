import type { SignUpResource } from "@clerk/expo/types";

const fields = {
	first_name: "firstName",
	last_name: "lastName",
	username: "username",
	email_address: "emailAddress",
	phone_number: "phoneNumber",
	password: "password",
	email_address_or_phone_number: "identifier",
} as const;
export type SignupDetailField = keyof typeof fields;
export type SignupDetails = Record<SignupDetailField, string>;
export function signupDetailFields(
	missing: SignUpResource["missingFields"],
): SignupDetailField[] | null {
	const result: SignupDetailField[] = [];
	for (const field of missing) {
		// The type guard uses own properties so unknown policy fields never become editable attributes.
		if (isDetailField(field)) result.push(field);
		else return null;
	}
	return result;
}
function isDetailField(field: string): field is SignupDetailField {
	return Object.hasOwn(fields, field);
}
export function emptySignupDetails(): SignupDetails {
	return {
		first_name: "",
		last_name: "",
		username: "",
		email_address: "",
		phone_number: "",
		password: "",
		email_address_or_phone_number: "",
	};
}
export function signupDetailsRequest(
	missing: SignUpResource["missingFields"],
	values: SignupDetails,
): Parameters<SignUpResource["update"]>[0] {
	const editable = signupDetailFields(missing);
	if (!editable?.length) throw new Error("Unsupported signup requirements");
	const body: Parameters<SignUpResource["update"]>[0] = {};
	for (const field of editable) {
		const value = field === "password" ? values[field] : values[field].trim();
		if (!value) throw new Error("Missing signup detail");
		const email =
			field === "email_address" ||
			(field === "email_address_or_phone_number" && !value.startsWith("+"));
		const phone =
			field === "phone_number" ||
			(field === "email_address_or_phone_number" && value.startsWith("+"));
		if (email && !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(value)) throw new Error("Invalid signup email");
		if (phone && !/^\+[1-9]\d{1,14}$/.test(value)) throw new Error("Invalid signup phone");
		if (field === "email_address_or_phone_number") {
			if (phone) body.phoneNumber = value;
			else body.emailAddress = value;
		} else body[fields[field]] = value;
	}
	return body;
}
