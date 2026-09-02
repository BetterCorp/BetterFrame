import { BaseSchema } from "./base.js";
import { ISSUE_CODES } from "../issue-codes.js";
import { validateFormat } from "../format/validators.js";
import { describeType } from "../util.js";
export class StringSchema extends BaseSchema {
    _minLength;
    _maxLength;
    _pattern;
    _startsWith;
    _endsWith;
    _includes;
    _format;
    /**
     * Cached compiled pattern. `undefined` = not yet compiled, `null` =
     * compilation failed (invalid pattern). Avoids recompiling on every value.
     */
    _patternRe;
    _getCoercionTarget() {
        return "string";
    }
    minLength(n) {
        const clone = this._clone();
        clone._minLength = n;
        return clone;
    }
    maxLength(n) {
        const clone = this._clone();
        clone._maxLength = n;
        return clone;
    }
    pattern(p) {
        const clone = this._clone();
        clone._pattern = p;
        // Reset cached compilation inherited from the source via _clone().
        clone._patternRe = undefined;
        return clone;
    }
    /** Lazily compile and cache the pattern. Returns null if invalid. */
    _getPatternRe() {
        if (this._patternRe !== undefined)
            return this._patternRe;
        try {
            this._patternRe = new RegExp(this._pattern);
        }
        catch {
            this._patternRe = null;
        }
        return this._patternRe;
    }
    startsWith(s) {
        const clone = this._clone();
        clone._startsWith = s;
        return clone;
    }
    endsWith(s) {
        const clone = this._clone();
        clone._endsWith = s;
        return clone;
    }
    includes(s) {
        const clone = this._clone();
        clone._includes = s;
        return clone;
    }
    format(f) {
        const clone = this._clone();
        clone._format = f;
        return clone;
    }
    _validate(input, ctx) {
        if (typeof input !== "string") {
            ctx.issues.push({
                code: ISSUE_CODES.INVALID_TYPE,
                message: `Expected string, received ${describeType(input)}`,
                path: [...ctx.path],
                expected: "string",
                received: describeType(input),
            });
            return undefined;
        }
        const val = input;
        const length = Array.from(val).length;
        if (this._minLength !== undefined && length < this._minLength) {
            ctx.issues.push({
                code: ISSUE_CODES.TOO_SMALL,
                message: `String must have at least ${this._minLength} character(s)`,
                path: [...ctx.path],
                expected: String(this._minLength),
                received: String(length),
            });
        }
        if (this._maxLength !== undefined && length > this._maxLength) {
            ctx.issues.push({
                code: ISSUE_CODES.TOO_LARGE,
                message: `String must have at most ${this._maxLength} character(s)`,
                path: [...ctx.path],
                expected: String(this._maxLength),
                received: String(length),
            });
        }
        if (this._pattern !== undefined) {
            const re = this._getPatternRe();
            if (re === null) {
                // Invalid regex pattern - treat as validation failure
                ctx.issues.push({
                    code: ISSUE_CODES.INVALID_STRING,
                    message: `Invalid regex pattern: ${this._pattern}`,
                    path: [...ctx.path],
                    expected: this._pattern,
                    received: val,
                });
            }
            else if (!re.test(val)) {
                ctx.issues.push({
                    code: ISSUE_CODES.INVALID_STRING,
                    message: `String does not match pattern: ${this._pattern}`,
                    path: [...ctx.path],
                    expected: this._pattern,
                    received: val,
                });
            }
        }
        if (this._startsWith !== undefined && !val.startsWith(this._startsWith)) {
            ctx.issues.push({
                code: ISSUE_CODES.INVALID_STRING,
                message: `String must start with "${this._startsWith}"`,
                path: [...ctx.path],
                expected: this._startsWith,
                received: val,
            });
        }
        if (this._endsWith !== undefined && !val.endsWith(this._endsWith)) {
            ctx.issues.push({
                code: ISSUE_CODES.INVALID_STRING,
                message: `String must end with "${this._endsWith}"`,
                path: [...ctx.path],
                expected: this._endsWith,
                received: val,
            });
        }
        if (this._includes !== undefined && !val.includes(this._includes)) {
            ctx.issues.push({
                code: ISSUE_CODES.INVALID_STRING,
                message: `String must include "${this._includes}"`,
                path: [...ctx.path],
                expected: this._includes,
                received: val,
            });
        }
        if (this._format !== undefined && !validateFormat(val, this._format)) {
            ctx.issues.push({
                code: ISSUE_CODES.INVALID_STRING,
                message: `Invalid ${this._format} format`,
                path: [...ctx.path],
                expected: this._format,
                received: val,
            });
        }
        return val;
    }
    _toNode() {
        const node = { kind: "string" };
        if (this._minLength !== undefined)
            node.minLength = this._minLength;
        if (this._maxLength !== undefined)
            node.maxLength = this._maxLength;
        if (this._pattern !== undefined)
            node.pattern = this._pattern;
        if (this._startsWith !== undefined)
            node.startsWith = this._startsWith;
        if (this._endsWith !== undefined)
            node.endsWith = this._endsWith;
        if (this._includes !== undefined)
            node.includes = this._includes;
        if (this._format !== undefined)
            node.format = this._format;
        this._addDefault(node);
        return node;
    }
}
//# sourceMappingURL=string.js.map