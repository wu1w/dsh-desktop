export class Service {
  constructor(ctx, name, config) {
    this.ctx = ctx;
    this.name = name ?? null;
    this.config = config;
    if (name) {
      ctx[name] = this;
      ctx._services.push({ name, service: this });
    }
  }
}

export class Context {
  constructor() {
    this._effects = [];
    this._services = [];
    this._children = [];
    this.fiber = {
      dispose: async () => {
        const children = this._children.splice(0);
        for (const child of children) await child.dispose();
        const effects = this._effects.splice(0);
        for (const effect of effects.reverse()) await effect.dispose();
        for (const entry of this._services) {
          if (this[entry.name] === entry.service) delete this[entry.name];
        }
      },
    };
  }

  effect(register) {
    const disposer = register();
    const record = {
      dispose: async () => {
        await disposer?.();
      },
    };
    this._effects.push(record);
    return () => record.dispose();
  }

  async plugin(Plugin, config) {
    const child = new Context();
    const plugin = new Plugin(child, config);
    for (const entry of child._services) this[entry.name] = entry.service;
    const fiber = {
      ctx: child,
      plugin,
      dispose: async () => {
        await child.fiber.dispose();
        for (const entry of child._services) {
          if (this[entry.name] === entry.service) delete this[entry.name];
        }
      },
    };
    this._children.push(fiber);
    return fiber;
  }
}
