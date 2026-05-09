import { ABSENT } from "../schemas/base.js";
/**
 * Apply a default value if the input is absent.
 * Returns the default value if input is absent, otherwise returns the input as-is.
 */
export function applyDefault(input, defaultValue) {
    if ((input === undefined || input === ABSENT) && defaultValue !== ABSENT) {
        return defaultValue;
    }
    return input;
}
//# sourceMappingURL=defaults.js.map