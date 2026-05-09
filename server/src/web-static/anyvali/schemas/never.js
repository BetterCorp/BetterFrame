import { BaseSchema } from "./base.js";
import { ISSUE_CODES } from "../issue-codes.js";
import { describeType } from "../util.js";
export class NeverSchema extends BaseSchema {
    _validate(input, ctx) {
        ctx.issues.push({
            code: ISSUE_CODES.INVALID_TYPE,
            message: `Expected never (no value is valid)`,
            path: [...ctx.path],
            expected: "never",
            received: describeType(input),
        });
        return undefined;
    }
    _toNode() {
        return { kind: "never" };
    }
}
//# sourceMappingURL=never.js.map