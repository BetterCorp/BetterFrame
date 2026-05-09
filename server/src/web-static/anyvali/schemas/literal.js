import { BaseSchema } from "./base.js";
import { ISSUE_CODES } from "../issue-codes.js";
export class LiteralSchema extends BaseSchema {
    _value;
    constructor(value) {
        super();
        this._value = value;
    }
    _validate(input, ctx) {
        if (input !== this._value) {
            ctx.issues.push({
                code: ISSUE_CODES.INVALID_LITERAL,
                message: `Expected literal ${String(this._value)}, received ${String(input)}`,
                path: [...ctx.path],
                expected: String(this._value),
                received: String(input),
            });
            return undefined;
        }
        return input;
    }
    _toNode() {
        const node = { kind: "literal", value: this._value };
        this._addDefault(node);
        return node;
    }
}
//# sourceMappingURL=literal.js.map