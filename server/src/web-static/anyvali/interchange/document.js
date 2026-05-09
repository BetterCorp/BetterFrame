export const ANYVALI_VERSION = "1.0";
export const SCHEMA_VERSION = "1";
export function createDocument(root, definitions = {}, extensions = {}) {
    return {
        anyvaliVersion: ANYVALI_VERSION,
        schemaVersion: SCHEMA_VERSION,
        root,
        definitions,
        extensions,
    };
}
//# sourceMappingURL=document.js.map