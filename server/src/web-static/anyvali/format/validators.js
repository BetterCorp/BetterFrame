// Email must have at least one dot after the @
const EMAIL_RE = /^[a-zA-Z0-9.!#$%&'*+/=?^_`{|}~-]+@[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?(?:\.[a-zA-Z0-9](?:[a-zA-Z0-9-]{0,61}[a-zA-Z0-9])?)+$/;
const UUID_RE = /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;
const IPV4_RE = /^(?:(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)\.){3}(?:25[0-5]|2[0-4]\d|1\d\d|[1-9]?\d)$/;
const IPV6_RE = /^(?:(?:[0-9a-fA-F]{1,4}:){7}[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,7}:|(?:[0-9a-fA-F]{1,4}:){1,6}:[0-9a-fA-F]{1,4}|(?:[0-9a-fA-F]{1,4}:){1,5}(?::[0-9a-fA-F]{1,4}){1,2}|(?:[0-9a-fA-F]{1,4}:){1,4}(?::[0-9a-fA-F]{1,4}){1,3}|(?:[0-9a-fA-F]{1,4}:){1,3}(?::[0-9a-fA-F]{1,4}){1,4}|(?:[0-9a-fA-F]{1,4}:){1,2}(?::[0-9a-fA-F]{1,4}){1,5}|[0-9a-fA-F]{1,4}:(?::[0-9a-fA-F]{1,4}){1,6}|:(?::[0-9a-fA-F]{1,4}){1,7}|::)$/;
// ISO 8601 date: YYYY-MM-DD
const DATE_RE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])$/;
// ISO 8601 date-time: YYYY-MM-DDTHH:MM:SS with optional fractional seconds and timezone
const DATETIME_RE = /^\d{4}-(?:0[1-9]|1[0-2])-(?:0[1-9]|[12]\d|3[01])T(?:[01]\d|2[0-3]):[0-5]\d:[0-5]\d(?:\.\d+)?(?:Z|[+-](?:[01]\d|2[0-3]):[0-5]\d)$/;
function isValidDate(str) {
    if (!DATE_RE.test(str))
        return false;
    const [y, m, d] = str.split("-").map(Number);
    const date = new Date(y, m - 1, d);
    return (date.getFullYear() === y &&
        date.getMonth() === m - 1 &&
        date.getDate() === d);
}
function isValidDateTime(str) {
    if (!DATETIME_RE.test(str))
        return false;
    // Validate the date portion
    const datePart = str.substring(0, 10);
    return isValidDate(datePart);
}
function isValidUrl(str) {
    try {
        const url = new URL(str);
        // Only accept http and https protocols
        return url.protocol === "http:" || url.protocol === "https:";
    }
    catch {
        return false;
    }
}
const FORMAT_VALIDATORS = {
    email: (val) => EMAIL_RE.test(val),
    url: isValidUrl,
    uuid: (val) => UUID_RE.test(val),
    ipv4: (val) => IPV4_RE.test(val),
    ipv6: (val) => IPV6_RE.test(val),
    date: isValidDate,
    "date-time": isValidDateTime,
};
export function validateFormat(value, format) {
    const validator = FORMAT_VALIDATORS[format];
    if (!validator)
        return true; // unknown formats pass
    return validator(value);
}
//# sourceMappingURL=validators.js.map