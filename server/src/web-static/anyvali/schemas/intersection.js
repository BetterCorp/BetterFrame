import { BaseSchema } from "./base.js";
export class IntersectionSchema extends BaseSchema {
    _schemas;
    constructor(schemas) {
        super();
        this._schemas = schemas;
    }
    _validate(input, ctx) {
        let result = input;
        let anyFailed = false;
        for (const schema of this._schemas) {
            const innerCtx = {
                path: [...ctx.path],
                issues: [],
            };
            const validated = schema._runPipeline(input, innerCtx);
            if (innerCtx.issues.length > 0) {
                ctx.issues.push(...innerCtx.issues);
                anyFailed = true;
            }
            else {
                // Merge object results
                if (typeof result === "object" &&
                    result !== null &&
                    typeof validated === "object" &&
                    validated !== null &&
                    !Array.isArray(result) &&
                    !Array.isArray(validated)) {
                    result = {
                        ...result,
                        ...validated,
                    };
                }
                else {
                    result = validated;
                }
            }
        }
        if (anyFailed) {
            return undefined;
        }
        return result;
    }
    _toNode() {
        const node = {
            kind: "intersection",
            allOf: this._schemas.map((s) => s._toNode()),
        };
        this._addDefault(node);
        return node;
    }
}
//# sourceMappingURL=intersection.js.map