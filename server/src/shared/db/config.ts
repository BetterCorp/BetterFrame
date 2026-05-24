import * as av from "@anyvali/js";

export const dbConfigSchema = av.object(
  {
    driver: av.enum_(["sqlite", "postgres"] as const).default("postgres"),
    sqlitePath: av.string().minLength(1).default("/var/lib/betterframe/betterframe.db"),
    url: av.string().default(""),
    host: av.string().default("postgres"),
    port: av.int().min(1).max(65535).default(5432),
    database: av.string().default("betterframe"),
    user: av.string().default("betterframe"),
    password: av.string().default("betterframe"),
    poolMax: av.int().min(1).max(1000).default(10),
  },
  { unknownKeys: "strip" },
);

export type DbConfig = {
  driver: "sqlite" | "postgres";
  sqlitePath: string;
  url: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  poolMax: number;
};
