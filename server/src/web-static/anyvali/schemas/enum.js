import { BaseSchema } from "./base.js";
import { ISSUE_CODES } from "../issue-codes.js";
export class EnumSchema extends BaseSchema {
    _values;
    constructor(values) {
        super();
        this._values = values;
    }
    _validate(input, ctx) {
        if (!this._values.includes(input)) {
            ctx.issues.push({
                code: ISSUE_CODES.INVALID_TYPE,
                message: `Expected one of enum(${this._values.join(",")}), received ${String(input)}`,
                path: [...ctx.path],
                expected: `enum(${this._values.join(",")})`,
                received: String(input),
            });
            return undefined;
        }
        return input;
    }
    _toNode() {
        const node = {
            kind: "enum",
            values: [...this._values],
        };
        this._addDefault(node);
        return node;
    }
}
//# sourceMappingURL=enum.js.map