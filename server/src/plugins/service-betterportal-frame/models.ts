import * as av from "anyvali";
export const ItemSchema = av.object({
  id: av.string(),
  name: av.string(),
  status: av.string(),
  summary: av.string(),
});
export const ListSchema = av.object({
  title: av.string(),
  items: av.array(ItemSchema),
  detailPath: av.optional(av.string()),
});
export const ActionSchema = av.object({
  ok: av.literal(true),
  id: av.string(),
  message: av.string(),
  returnPath: av.string(),
});
export const IdSchema = av.object({ id: av.string().minLength(1).maxLength(128) });
