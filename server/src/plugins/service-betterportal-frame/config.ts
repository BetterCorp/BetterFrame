import type { ConfigSchemaDescriptor } from "@betterportal/framework";

export const FrameTenantConfigSchemas: ConfigSchemaDescriptor[] = [
  {
    id: "frame.tenant.access",
    title: "Resource access",
    scope: "tenant",
    description:
      "Choose whether Frame resources are shared within this tenant or isolated by BP user.",
    jsonSchema: { userIsolationEnabled: "boolean" },
    fields: [
      {
        key: "userIsolationEnabled",
        title: "Isolate resources by user",
        description:
          "Off: users share tenant resources according to their BP permissions. On: users can access only their own resources; the admin role can access all tenant resources. Node-RED always requires admin.",
        scope: "tenant",
        visibility: "protected",
        ownership: "bp",
        sourceOfTruth: "bp",
        required: false,
        defaultValue: false,
        ui: { control: "checkbox" },
      },
    ],
  },
];

export function userIsolationEnabled(config: Record<string, unknown>): boolean {
  const value = config.userIsolationEnabled;
  if (value === undefined) return false;
  if (typeof value !== "boolean") throw new Error("BP tenant userIsolationEnabled must be boolean");
  return value;
}
