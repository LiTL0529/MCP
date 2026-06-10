/** The authenticated caller, derived from their API key. */
export interface UserContext {
  userId: string;
  email: string;
  name: string | null;
  accessGroups: string[];
  isAdmin: boolean;
}

export type Lang = "en" | "zh" | "both";

export interface SourceRef {
  tier?: string;
  title?: string;
  url?: string;
}

/** An image attached to an insight, as stored in `ja_insights.images`. */
export interface ImageRef {
  url: string;                 // public Storage URL
  alt?: string | null;
  caption?: string | null;
  description?: string | null; // vision-model description that was embedded
}

/** An image as submitted to the ingest API (before upload/description). */
export interface ImageInput {
  data?: string;   // base64 data URL (data:image/png;base64,...) — uploaded server-side
  url?: string;    // OR an already-hosted URL (used as-is, still described)
  alt?: string | null;
  caption?: string | null;
}
