export const developmentTool={
  name:'dsh_plugins',
  description:'Develop and hot-update DSH itself through versioned plugins. Call guide first. Create or checkout a draft, read/write files using the returned digest, validate, then apply using both digest and expectedRevision. A user must grant this chat plugin development in Settings > Plugins before mutations or executing plugin tools. Never bypass that grant using shell. Each deployment preserves previous code and reverts on startup/mount failure; it does not undo plugin side effects on user files. Do not alter chat history, memories or agent settings to implement a plugin. Use tools to discover freshly registered tools, then call with toolId and JSON input; they are available immediately without restarting the chat. Report actual validation/deployment results.',
  inputSchema:{type:'object',properties:{
    action:{type:'string',enum:['guide','list','create','checkout','files','read','write','validate','apply','history','rollback','tools','call']},
    pluginId:{type:'string',description:'Lowercase plugin ID with hyphens, e.g. my-helper.'},
    file:{type:'string',description:'Relative draft path; no traversal or symlinks.'},
    content:{type:'string',maxLength:200000,description:'UTF-8 source for write.'},
    digest:{type:'string',description:'Exact current draft digest; required for write, validate and apply.'},
    expectedRevision:{type:'string',description:'Current installed revision; use new if not installed.'},
    revision:{type:'string',description:'Version ID from history, to restore.'},
    toolId:{type:'string',description:'Exact ID returned by tools.'},
    input:{type:'string',description:'JSON object passed to a registered plugin tool.'}
  },required:['action'],additionalProperties:false}
};
