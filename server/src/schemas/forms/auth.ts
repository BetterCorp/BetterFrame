/**
 * Form schemas for the auth flow.
 *
 * Server: parsed from x-www-form-urlencoded body before any DB access.
 * Browser: same schemas drive HTML5 attributes via @anyvali/js/forms.
 */
import * as av from "@anyvali/js";

const usernamePattern = "^[a-zA-Z0-9_-]+$";

export const setupForm = av.object(
  {
    username: av.string().minLength(3).maxLength(64).pattern(usernamePattern),
    password: av.string().minLength(12).maxLength(256),
    password_confirm: av.string().minLength(12).maxLength(256),
  },
  { unknownKeys: "strip" },
);

export const loginForm = av.object(
  {
    username: av.string().minLength(1).maxLength(64),
    password: av.string().minLength(1).maxLength(256),
  },
  { unknownKeys: "strip" },
);

export const totpForm = av.object(
  {
    code: av.string().pattern("^\\d{6}$"),
  },
  { unknownKeys: "strip" },
);

export const recoveryForm = av.object(
  {
    code: av.string().minLength(6).maxLength(20),
  },
  { unknownKeys: "strip" },
);

export type SetupForm = av.Infer<typeof setupForm>;
export type LoginForm = av.Infer<typeof loginForm>;
export type TotpForm = av.Infer<typeof totpForm>;
export type RecoveryForm = av.Infer<typeof recoveryForm>;
