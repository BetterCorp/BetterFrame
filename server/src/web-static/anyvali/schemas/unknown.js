import { BaseSchema } from "./base.js";
export class UnknownSchema extends BaseSchema {
    _validate(input, _ctx) {
        return input;
    }
    _toNode() {
        const node = { kind: "unknown" };
        this._addDefault(node);
        return node;
    }
}
//# sourceMappingURL=unknown.js.map