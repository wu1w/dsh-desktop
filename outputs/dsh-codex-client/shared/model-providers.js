// Provider defaults follow the upstream Harness catalog. Protocols are explicit;
// a provider name never implies that every execution engine can consume it.
export const MODEL_PROTOCOLS=['openai-completions','openai-responses','anthropic-messages'];
export const providerPresets=[
  {id:'deepseek',name:'DeepSeek',api:'openai-completions',baseURL:'https://api.deepseek.com'},
  {id:'openai',name:'OpenAI',api:'openai-responses',baseURL:'https://api.openai.com/v1'},
  {id:'gemini',name:'Google Gemini',api:'openai-completions',baseURL:'https://generativelanguage.googleapis.com/v1beta/openai'},
  {id:'anthropic',name:'Anthropic',api:'anthropic-messages',baseURL:'https://api.anthropic.com'},
  {id:'openrouter',name:'OpenRouter',api:'openai-completions',baseURL:'https://openrouter.ai/api/v1'},
  {id:'moonshot',name:'Moonshot / Kimi',api:'openai-completions',baseURL:'https://api.moonshot.cn/v1'},
  {id:'zai',name:'Z.ai / GLM',api:'openai-completions',baseURL:'https://open.bigmodel.cn/api/coding/paas/v4'},
  {id:'minimax',name:'MiniMax',api:'anthropic-messages',baseURL:'https://api.minimaxi.com/anthropic'},
  {id:'siliconflow',name:'SiliconFlow',api:'openai-completions',baseURL:'https://api.siliconflow.cn/v1'},
  {id:'dashscope',name:'Qwen / DashScope',api:'openai-completions',baseURL:'https://dashscope.aliyuncs.com/compatible-mode/v1'},
  {id:'qwen',name:'Qwen Token Plan',api:'openai-completions',baseURL:'https://token-plan.cn-beijing.maas.aliyuncs.com/compatible-mode/v1'},
  {id:'xai',name:'xAI',api:'openai-completions',baseURL:'https://api.x.ai/v1'},
  {id:'groq',name:'Groq',api:'openai-completions',baseURL:'https://api.groq.com/openai/v1'},
  {id:'nvidia',name:'NVIDIA',api:'openai-completions',baseURL:'https://integrate.api.nvidia.com/v1'},
  {id:'ollama',name:'Ollama',api:'openai-completions',baseURL:'http://127.0.0.1:11434/v1',auth:'none'},
  {id:'lmstudio',name:'LM Studio',api:'openai-completions',baseURL:'http://127.0.0.1:1234/v1',auth:'none'},
  {id:'custom',name:'Custom API',api:'openai-completions',baseURL:''},
];
export const protocolForEngine=(provider,engine)=>provider.endpoints?.[engine]??(engine==='codex'&&provider.api!=='openai-responses'||engine==='claude-code'&&provider.api!=='anthropic-messages'?null:{api:provider.api,baseURL:provider.baseURL});
export const modelSelection=(provider,id)=>provider==='opencode_go'?id:`@${provider}/${id}`;
