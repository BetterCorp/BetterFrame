import * as av from "@anyvali/js";

export const dbConfigSchema = av.object(
  {
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
  url: string;
  host: string;
  port: number;
  database: string;
  user: string;
  password: string;
  poolMax: number;
};
