export async function resolve(specifier, context, nextResolve) {
  if (specifier === "cordis") {
    return {
      url: new URL("./fake-cordis.js", import.meta.url).href,
      shortCircuit: true,
      format: "module",
    };
  }
  return nextResolve(specifier, context);
}
