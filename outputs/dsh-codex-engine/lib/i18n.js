import en from "../locale/en.json" with { type: "json" };
import zhCN from "../locale/zh-CN.json" with { type: "json" };

const CATALOGS = {
  en,
  "zh-CN": zhCN,
  zh: zhCN,
};

export function createTranslator(locale = "zh-CN") {
  const chain = [];
  const requested = CATALOGS[locale] ? locale : null;
  if (requested) chain.push(requested);
  const language = String(locale).split("-")[0];
  if (CATALOGS[language] && !chain.includes(language)) chain.push(language);
  if (!chain.includes("en")) chain.push("en");

  return function translate(key, vars = {}) {
    let template = key;
    for (const name of chain) {
      const value = CATALOGS[name][key];
      if (typeof value === "string") {
        template = value;
        break;
      }
    }
    return template.replace(/\{(\w+)\}/g, (_, name) => (vars[name] == null ? "" : String(vars[name])));
  };
}

export function formatTime(iso, locale = "zh-CN") {
  const date = new Date(iso);
  if (Number.isNaN(date.getTime())) return "";
  const tag = String(locale).toLowerCase().startsWith("zh") ? "zh-CN" : "en";
  return new Intl.DateTimeFormat(tag, { dateStyle: "medium", timeStyle: "short" }).format(date);
}
