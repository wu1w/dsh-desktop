# Notice

`@dsh/native-engine` is an independent adapter. It embeds the published MIT
packages from DeepSeek Harness `0.2.1-rc.2`, including
`@deepseek-ai/dsh-agent-loop`. Those packages stay under their upstream
license. See each package's `LICENSE` file after installation and
`https://github.com/deepseek-ai/deepseek-harness`.

This adapter does not copy the DeepSeek desktop application. It does not read
`~/.dsh` or credential files. API keys arrive only through the `resolveApiKey`
callback.

The model route is DeepSeek `deepseek-v4.1-flash` through OpenCode Go's
Anthropic-compatible endpoint
`https://opencode.ai/inference/go/anthropic`, using the official
`@deepseek-ai/dsh-llm-deepseek` adapter. Tests may replace that adapter with
`ScriptedAdapter`, which still drives the real agent loop.
