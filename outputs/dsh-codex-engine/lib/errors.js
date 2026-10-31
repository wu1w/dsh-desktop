export class EngineError extends Error {
  constructor(code, key, vars = {}, translator = null) {
    super(translator ? translator(key, vars) : code);
    this.name = "EngineError";
    this.code = code;
    this.key = key;
    this.vars = vars;
  }
}

export class ClientClosed extends Error {
  constructor(code, extra = null) {
    super(code);
    this.name = "ClientClosed";
    this.code = code;
    if (extra) Object.assign(this, extra);
  }
}
