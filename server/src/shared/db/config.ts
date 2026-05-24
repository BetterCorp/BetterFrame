import * as av from "@anyvali/js";

export const dbConfigSchema = av.object(
  {
    driver: av.enum_(["sqlite", "postgres"] as const).default("postgres"),
    sqlitePath: av.string().minLength(1).default("/var/lib/betterframe/betterframe.db"),
    pgUrl: av.string().default(""),
    pgHost: av.string().default("postgres"),
    pgPort: av.int().min(1).max(65535).default(5432),
    pgDatabase: av.string().default("betterframe"),
    pgUser: av.string().default("betterframe"),
    pgPassword: av.string().default("betterframe"),
    pgPoolMax: av.int().min(1).max(1000).default(10),
  },
  { unknownKeys: "strip" },
);

export type DbConfig = {
  driver: "sqlite" | "postgres";
  sqlitePath: string;
  pgUrl: string;
  pgHost: string;
  pgPort: number;
  pgDatabase: string;
  pgUser: string;
  pgPassword: string;
  pgPoolMax: number;
};
