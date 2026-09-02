/**
 * Form schemas for camera + kiosk admin pages.
 *
 * Camera-create is a discriminated union on `type`. anyvali's `union`
 * picks first match, with the `literal` field as the discriminant.
 */
import * as av from "anyvali";

const labelName = av.string().minLength(1).maxLength(64).pattern("^[a-z0-9][a-z0-9_-]*$");

const cameraCreateRtsp = av.object(
  {
    name: av.string().minLength(1).maxLength(128),
    type: av.literal("rtsp"),
    rtsp_url: av.string().minLength(1).maxLength(1024),
  },
  { unknownKeys: "strip" },
);

const cameraCreateOnvif = av.object(
  {
    name: av.string().minLength(1).maxLength(128),
    type: av.literal("onvif"),
    onvif_host: av.string().minLength(1).maxLength(255),
    onvif_port: av.optional(av.int().min(1).max(65535)),
    onvif_username: av.optional(av.string().maxLength(128)),
    onvif_password: av.optional(av.string().maxLength(256)),
  },
  { unknownKeys: "strip" },
);

export const cameraCreateForm = av.union([cameraCreateRtsp, cameraCreateOnvif]);

export const kioskPairConfirmForm = av.object(
  {
    code: av.string().pattern("^[A-HJ-NP-Z2-9]{8}$"),
    name_override: av.optional(av.string().minLength(1).maxLength(128)),
    /** Comma-separated label names. The handler splits on commas. */
    initial_labels: av.optional(av.string().maxLength(1024)),
  },
  { unknownKeys: "strip" },
);

export const labelCreateForm = av.object(
  {
    name: labelName,
    description: av.optional(av.string().maxLength(256)),
    color: av.optional(av.string().maxLength(16)),
  },
  { unknownKeys: "strip" },
);

export type CameraCreateForm = av.Infer<typeof cameraCreateForm>;
export type KioskPairConfirmForm = av.Infer<typeof kioskPairConfirmForm>;
export type LabelCreateForm = av.Infer<typeof labelCreateForm>;
