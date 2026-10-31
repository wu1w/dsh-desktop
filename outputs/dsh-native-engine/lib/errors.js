export class EngineError extends Error {
  constructor(code, message, extra = {}) {
    super(message);
    this.name = "EngineError";
    this.code = code;
    Object.assign(this, extra);
  }
}
