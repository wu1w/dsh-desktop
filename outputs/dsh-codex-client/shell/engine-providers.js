// Registration ownership, not package naming, determines executable engines.
// An advertised registry is authoritative even when empty or malformed; only
// older hosts without the field use the original built-in naming convention.
export function pluginEngineProviders(plugin,source={}){
  if(!plugin?.enabled||!plugin.active)return [];
  if(Object.hasOwn(source??{},'engineProviders')){
    const seen=new Set();
    return (Array.isArray(source.engineProviders)?source.engineProviders:[]).filter(provider=>{
      if(!provider||provider.pluginId!==plugin.id||typeof provider.id!=='string'||!provider.id||seen.has(provider.id))return false;
      seen.add(provider.id);return true;
    });
  }
  const id=typeof plugin.id==='string'?plugin.id.replace(/^engine-/,''):'';
  return id?[{id,pluginId:plugin.id}]:[];
}

export function engineRegistrySource(state,catalog){
  return Object.hasOwn(state??{},'engineProviders')?state:catalog??state??{};
}
