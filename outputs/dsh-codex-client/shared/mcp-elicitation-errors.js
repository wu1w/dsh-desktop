export const mcpElicitationErrors={
  MCP_ELICITATION_UNSUPPORTED:['当前表单包含尚不支持的类型或规则，不能发送回答。你可以拒绝或取消本次请求。','This form contains unsupported types or rules. You can decline or cancel the request.'],
  MCP_ELICITATION_INVALID_CONTENT:['表单内容不符合请求，请检查必填项、类型和范围。','The form does not match the request. Check required fields, types, and ranges.'],
  MCP_ELICITATION_LIMIT:['表单或回答超过本机处理上限，请缩短内容后重试。','The form or response exceeds the local limit. Shorten the content and retry.'],
  APPROVAL_HANDLER_CONFLICT:['已有插件处理这类问询。请先停用原提供者。','Another plugin handles this request type. Disable its provider first.'],
  APPROVAL_HANDLER_INVALID:['问询插件返回了无效结果，未发送回答。请停用后重试。','The request plugin returned an invalid result. No answer was sent. Disable it and retry.'],
};
