import { createContext, useContext } from "react";
import { en, type TranslationKey } from "@/lib/i18n/en";

type TranslationTree = typeof en;

function readTranslation(
	tree: TranslationTree,
	key: TranslationKey,
	values?: Record<string, string | number | null | undefined>,
): string {
	const [section, name] = key.split(".") as [keyof TranslationTree, string];
	const value: Readonly<Record<string, unknown>> = tree[section];
	if (typeof value !== "object" || value === null || !(name in value)) {
		return key;
	}
	const translation = value[name];
	if (typeof translation !== "string") return key;
	return values
		? translation.replace(/\{([A-Za-z]\w*)\}/g, (placeholder, name: string) =>
				Object.hasOwn(values, name) ? String(values[name]) : placeholder,
			)
		: translation;
}

export type Translator = (
	key: TranslationKey,
	values?: Record<string, string | number | null | undefined>,
) => string;

const translator: Translator = (key, values) => readTranslation(en, key, values);
const I18nContext = createContext<Translator>(translator);

export function I18nProvider({ children }: { children: React.ReactNode }) {
	return <I18nContext.Provider value={translator}>{children}</I18nContext.Provider>;
}

export function useI18n(): Translator {
	return useContext(I18nContext);
}
