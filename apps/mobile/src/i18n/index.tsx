import { createContext, useContext } from "react";
import { en, type TranslationKey } from "./en";

type TranslationTree = typeof en;

function readTranslation(tree: TranslationTree, key: TranslationKey): string {
	const [section, name] = key.split(".") as [keyof TranslationTree, string];
	const value = tree[section];
	if (typeof value !== "object" || value === null || !(name in value)) {
		return key;
	}
	const translation = value[name as keyof typeof value];
	return typeof translation === "string" ? translation : key;
}

export type Translator = (key: TranslationKey) => string;

const I18nContext = createContext<Translator>((key) => readTranslation(en, key));

export function I18nProvider({ children }: { children: React.ReactNode }) {
	return (
		<I18nContext.Provider value={(key) => readTranslation(en, key)}>
			{children}
		</I18nContext.Provider>
	);
}

export function useI18n(): Translator {
	return useContext(I18nContext);
}
