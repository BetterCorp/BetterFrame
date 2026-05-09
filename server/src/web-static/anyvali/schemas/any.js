import { BaseSchema } from "./base.js";
export class AnySchema extends BaseSchema {
    _validate(input, _ctx) {
        return input;
    }
    _toNode() {
        const node = { kind: "any" };
        this._addDefault(node);
        return node;
    }
}
//# sourceMappingURL=any.js.map