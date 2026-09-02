import { BaseSchema, ABSENT } from "./base.js";
export class NullableSchema extends BaseSchema {
    /** @internal */ _inner;
    constructor(inner) {
        super();
        this._inner = inner;
    }
    _validate(input, ctx) {
        if (input === null) {
            return null;
        }
        return this._inner._validate(input, ctx);
    }
    _runPipeline(input, ctx) {
        if (input === null) {
            return null;
        }
        if (this._metadata?.sensitive === true && ctx.sensitiveMode) {
            return super._runPipeline(input, ctx);
        }
        if ((input === undefined || input === ABSENT) && this._defaultValue !== ABSENT) {
            return super._runPipeline(input, ctx);
        }
        return this._inner._runPipeline(input, ctx);
    }
    _toNode() {
        const node = {
            kind: "nullable",
            inner: this._inner._toNode(),
        };
        this._addDefault(node);
        return node;
    }
}
//# sourceMappingURL=nullable.js.map