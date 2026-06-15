import { supabase } from "./supabase.js";
import type { UserContext } from "./types.js";

// ── 需求社区 (community): posts + comments ─────────────────
// Any authenticated user may list/read/post/comment. Identity is stamped from
// the auth context (never from the request body). Uses the service-role client;
// the tables are RLS-restricted / service-role only.

export interface PostListParams {
  limit?: number;
  offset?: number;
}

export async function listPosts(p: PostListParams) {
  const limit = Math.min(Math.max(p.limit ?? 10, 1), 100);
  const offset = Math.max(p.offset ?? 0, 0);
  const { data, count, error } = await supabase
    .from("ja_community_posts")
    .select(
      "id, author_email, author_name, title, body, pinned, created_at, attachments, ja_community_comments(count)",
      { count: "exact" },
    )
    .order("pinned", { ascending: false })
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw new Error(`listPosts failed: ${error.message}`);
  const items = (data ?? []).map((row: any) => ({
    id: row.id,
    author_email: row.author_email,
    author_name: row.author_name,
    title: row.title,
    excerpt: typeof row.body === "string" ? row.body.slice(0, 180) : "",
    pinned: row.pinned,
    created_at: row.created_at,
    attachments: row.attachments || [],
    comment_count: Array.isArray(row.ja_community_comments) && row.ja_community_comments[0]
      ? row.ja_community_comments[0].count
      : 0,
  }));
  return { total: count ?? 0, limit, offset, items };
}

export async function createPost(
  user: UserContext,
  title: string,
  body: string,
  attachments: Array<{ name: string; url: string; type: string; size: number }> = [],
) {
  const { data, error } = await supabase
    .from("ja_community_posts")
    .insert({
      author_id: user.userId ?? null,
      author_email: user.email,
      author_name: user.name,
      title,
      body,
      attachments,
    })
    .select("id, created_at")
    .single();
  if (error) throw new Error(`createPost failed: ${error.message}`);
  return data;
}

export async function getPost(id: string) {
  const { data: post, error } = await supabase
    .from("ja_community_posts")
    .select("id, author_email, author_name, title, body, pinned, created_at, attachments")
    .eq("id", id)
    .maybeSingle();
  if (error) throw new Error(`getPost failed: ${error.message}`);
  if (!post) return null;
  const { data: comments, error: cErr } = await supabase
    .from("ja_community_comments")
    .select("id, author_email, author_name, body, created_at")
    .eq("post_id", id)
    .order("created_at", { ascending: true });
  if (cErr) throw new Error(`getPost comments failed: ${cErr.message}`);
  return { post, comments: comments ?? [] };
}

export async function addPostComment(user: UserContext, postId: string, body: string) {
  const { data: post } = await supabase
    .from("ja_community_posts")
    .select("id")
    .eq("id", postId)
    .maybeSingle();
  if (!post) return null; // post doesn't exist
  const { data, error } = await supabase
    .from("ja_community_comments")
    .insert({
      post_id: postId,
      author_id: user.userId ?? null,
      author_email: user.email,
      author_name: user.name,
      body,
    })
    .select("id, created_at")
    .single();
  if (error) throw new Error(`addPostComment failed: ${error.message}`);
  return data;
}
