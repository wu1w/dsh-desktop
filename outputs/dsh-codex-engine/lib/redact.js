const SECRET_ASSIGNMENT = /(OPENAI_API_KEY|CODEX_API_KEY|DSH_OPENCODE_GO_KEY|AUTHORIZATION)\s*[=:]\s*([^\s,;]+)/gi;
const BEARER = /Bearer\s+\S+/gi;
const SK_TOKEN = /sk-[A-Za-z0-9_-]{6,}/g;

export function redactText(text, secrets = [], cap = 8192) {
  let out = String(text);
  const unique = [];
  for (const secret of secrets) {
    if (typeof secret === "string" && secret.length >= 4 && !unique.includes(secret)) unique.push(secret);
  }
  unique.sort((a, b) => b.length - a.length);
  for (const secret of unique) out = out.split(secret).join("[redacted]");
  out = out.replace(SECRET_ASSIGNMENT, "$1=[redacted]");
  out = out.replace(BEARER, "Bearer [redacted]");
  out = out.replace(SK_TOKEN, "[redacted]");
  if (out.length > cap) out = `${out.slice(0, cap)}…`;
  return out;
}
