import { readFileSync } from "node:fs";

const catalogs = Object.fromEntries(["en", "zh-CN"].map((locale) => [
  locale,
  JSON.parse(readFileSync(new URL(`../locale/${locale}.json`, import.meta.url), "utf8")),
]));

export function createTranslator(locale = "zh-CN") {
  const selected = catalogs[locale] ?? catalogs.en;
  return (key) => selected[key] ?? catalogs.en[key] ?? key;
}
