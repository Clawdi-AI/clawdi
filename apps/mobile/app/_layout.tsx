// Hermes has no Intl.supportedValuesOf; the official FormatJS polyfill adds it only when
// missing, so shared helpers (e.g. supportedTimezones) see the full IANA list.
import "@formatjs/intl-supportedvaluesof/polyfill.js";

export { default, ErrorBoundary, unstable_settings } from "@/platform/navigation/root-layout";
