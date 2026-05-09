import { BaseSchema } from "./base.js";
import { ISSUE_CODES } from "../issue-codes.js";
import { describeType } from "../util.js";
export class NullSchema extends BaseSchema {
    _validate(input, ctx) {
        if (input !== null) {
            ctx.issues.push({
                code: ISSUE_CODES.INVALID_TYPE,
                message: `Expected null, received ${describeType(input)}`,
                path: [...ctx.path],
                expected: "null",
                received: describeType(input),
            });
            return undefined;
        }
        return null;
    }
    _toNode() {
        const node = { kind: "null" };
        this._addDefault(node);
        return node;
    }
}
//# sourceMappingURL=null.js.map