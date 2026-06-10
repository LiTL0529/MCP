import { randomUUID } from "node:crypto";
import { supabase } from "./supabase.js";
import { config } from "./config.js";

/**
 * Upload helpers for insight images. The server holds the service-role key, so
 * it uploads directly to the public bucket and returns the public URL that gets
 * stored in `ja_insights.images[].url`.
 */

interface DecodedImage {
  buffer: Buffer;
  contentType: string;
  ext: string;
}

const EXT_BY_TYPE: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/jpg": "jpg",
  "image/webp": "webp",
  "image/gif": "gif",
  "image/svg+xml": "svg",
  "image/avif": "avif",
};

/** Accepts a `data:<type>;base64,<payload>` URL or a bare base64 string. */
function decodeDataUrl(data: string): DecodedImage {
  const m = data.match(/^data:([^;,]+);base64,(.*)$/s);
  const contentType = m ? m[1].toLowerCase() : "image/png";
  const base64 = m ? m[2] : data;
  const buffer = Buffer.from(base64, "base64");
  if (!buffer.length) throw new Error("image data is empty or not valid base64");
  const ext = EXT_BY_TYPE[contentType] ?? ((contentType.split("/")[1] || "png").replace(/[^a-z0-9]/g, "") || "png");
  return { buffer, contentType, ext };
}

/** Upload a base64 (data-URL) image and return its public URL + storage path. */
export async function uploadImage(data: string): Promise<{ url: string; path: string }> {
  const { buffer, contentType, ext } = decodeDataUrl(data);
  const path = `${randomUUID()}.${ext}`;

  const { error } = await supabase.storage
    .from(config.storageBucket)
    .upload(path, buffer, { contentType, upsert: false });
  if (error) throw new Error(`image upload failed: ${error.message}`);

  const { data: pub } = supabase.storage.from(config.storageBucket).getPublicUrl(path);
  return { url: pub.publicUrl, path };
}
