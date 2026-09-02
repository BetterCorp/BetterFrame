/**
 * Form schemas for the account-management pages.
 */
import * as av from "anyvali";

export const passwordChangeForm = av.object(
  {
    current_password: av.string().minLength(1).maxLength(256),
    new_password: av.string().minLength(12).maxLength(256),
  },
  { unknownKeys: "strip" },
);

export const totpConfirmForm = av.object(
  {
    enrollment_id: av.string().minLength(1).maxLength(64),
    code: av.string().pattern("^\\d{6}$"),
  },
  { unknownKeys: "strip" },
);

export const totpDisableForm = av.object(
  {
    password: av.string().minLength(1).maxLength(256),
  },
  { unknownKeys: "strip" },
);

export type PasswordChangeForm = av.Infer<typeof passwordChangeForm>;
export type TotpConfirmForm = av.Infer<typeof totpConfirmForm>;
export type TotpDisableForm = av.Infer<typeof totpDisableForm>;
