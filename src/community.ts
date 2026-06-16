import { supabase } from "./supabase.js";
import type { UserContext } from "./types.js";

// ── 需求社区 (community): posts + comments ─────────────────
// Any authenticated user may list/read/post/comment. Identity is stamped from
// the auth context (never from the request body). Uses the service-role client;
// the tables are RLS-restricted / service-role only.

export interface PostListParams {
  limit?: number;
  offset?: number;
  /** Restrict to the current user's own posts (我的发帖). */
  mine?: boolean;
}

// Stable per-user identity for likes/favorites. userId is always present on an
// authenticated UserContext; fall back to email defensively.
function reactorId(user: UserContext): string {
  return user.userId || user.email;
}

const POST_SELECT =
  "id, author_email, author_name, title, body, pinned, created_at, attachments, " +
  "ja_community_comments(count), ja_community_likes(count), ja_community_favorites(count)";

function embeddedCount(v: any): number {
  return Array.isArray(v) && v[0] ? Number(v[0].count) || 0 : 0;
}

/** Which of `postIds` the user has liked / favorited — returned as two Sets. */
async function myReactions(user: UserContext, postIds: string[]) {
  const liked = new Set<string>();
  const faved = new Set<string>();
  if (!postIds.length) return { liked, faved };
  const uid = reactorId(user);
  const [l, f] = await Promise.all([
    supabase.from("ja_community_likes").select("post_id").eq("user_id", uid).in("post_id", postIds),
    supabase.from("ja_community_favorites").select("post_id").eq("user_id", uid).in("post_id", postIds),
  ]);
  for (const r of l.data ?? []) liked.add((r as any).post_id);
  for (const r of f.data ?? []) faved.add((r as any).post_id);
  return { liked, faved };
}

function mapPostRow(row: any, liked: Set<string>, faved: Set<string>) {
  return {
    id: row.id,
    author_email: row.author_email,
    author_name: row.author_name,
    title: row.title,
    excerpt: typeof row.body === "string" ? row.body.slice(0, 180) : "",
    pinned: row.pinned,
    created_at: row.created_at,
    attachments: row.attachments || [],
    comment_count: embeddedCount(row.ja_community_comments),
    like_count: embeddedCount(row.ja_community_likes),
    fav_count: embeddedCount(row.ja_community_favorites),
    liked_by_me: liked.has(row.id),
    faved_by_me: faved.has(row.id),
  };
}

export async function listPosts(user: UserContext, p: PostListParams) {
  const limit = Math.min(Math.max(p.limit ?? 10, 1), 100);
  const offset = Math.max(p.offset ?? 0, 0);
  let query = supabase
    .from("ja_community_posts")
    .select(POST_SELECT, { count: "exact" })
    .order("pinned", { ascending: false })
    .order("created_at", { ascending: false });
  // 我的发帖: only the caller's own posts (matched by their authenticated email).
  if (p.mine) query = query.eq("author_email", user.email);
  const { data, count, error } = await query.range(offset, offset + limit - 1);
  if (error) throw new Error(`listPosts failed: ${error.message}`);
  const rows = data ?? [];
  const { liked, faved } = await myReactions(user, rows.map((r: any) => r.id));
  const items = rows.map((row: any) => mapPostRow(row, liked, faved));
  return { total: count ?? 0, limit, offset, items };
}

/**
 * Posts the user reacted to (favorited or liked), newest-reaction first.
 * `table` is the join table; the matching flag (faved/liked) is forced true for
 * all returned rows since membership in that table implies it.
 */
async function listReacted(user: UserContext, table: string, p: PostListParams) {
  const limit = Math.min(Math.max(p.limit ?? 10, 1), 100);
  const offset = Math.max(p.offset ?? 0, 0);
  const uid = reactorId(user);
  const { data: rows, count, error } = await supabase
    .from(table)
    .select("post_id", { count: "exact" })
    .eq("user_id", uid)
    .order("created_at", { ascending: false })
    .range(offset, offset + limit - 1);
  if (error) throw new Error(`list ${table} failed: ${error.message}`);
  const ids = (rows ?? []).map((r: any) => r.post_id);
  if (!ids.length) return { total: count ?? 0, limit, offset, items: [] };
  const { data: posts, error: pErr } = await supabase
    .from("ja_community_posts")
    .select(POST_SELECT)
    .in("id", ids);
  if (pErr) throw new Error(`list ${table} posts failed: ${pErr.message}`);
  const { liked, faved } = await myReactions(user, ids);
  const byId = new Map((posts ?? []).map((row: any) => [row.id, mapPostRow(row, liked, faved)]));
  const items = ids.map((id: string) => byId.get(id)).filter(Boolean); // preserve reaction order
  return { total: count ?? 0, limit, offset, items };
}

/** Posts the current user has favorited, newest-favorited first (paginated). */
export function listFavorites(user: UserContext, p: PostListParams) {
  return listReacted(user, "ja_community_favorites", p);
}

/** Posts the current user has liked, newest-liked first (paginated). */
export function listLikes(user: UserContext, p: PostListParams) {
  return listReacted(user, "ja_community_likes", p);
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

/**
 * Edit a post's title/body. Only the original author (matched by email/id) or an
 * admin may edit; identity comes from the auth context, never the request body.
 * Attachments are left unchanged.
 */
export async function updatePost(
  user: UserContext,
  id: string,
  fields: { title: string; body: string },
): Promise<{ ok: boolean; reason?: "not_found" | "forbidden" }> {
  const { data: post, error: fErr } = await supabase
    .from("ja_community_posts")
    .select("id, author_email, author_id")
    .eq("id", id)
    .maybeSingle();
  if (fErr) throw new Error(`updatePost lookup failed: ${fErr.message}`);
  if (!post) return { ok: false, reason: "not_found" };
  const row = post as { author_email: string | null; author_id: string | null };
  const isOwner =
    (!!row.author_email && row.author_email === user.email) ||
    (!!row.author_id && row.author_id === user.userId);
  if (!isOwner && !user.isAdmin) return { ok: false, reason: "forbidden" };
  const { error } = await supabase
    .from("ja_community_posts")
    .update({ title: fields.title, body: fields.body, updated_at: new Date().toISOString() })
    .eq("id", id);
  if (error) throw new Error(`updatePost failed: ${error.message}`);
  return { ok: true };
}

export async function getPost(user: UserContext, id: string) {
  const { data: post, error } = await supabase
    .from("ja_community_posts")
    .select(
      "id, author_email, author_name, title, body, pinned, created_at, attachments, " +
        "ja_community_likes(count), ja_community_favorites(count)",
    )
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
  const { liked, faved } = await myReactions(user, [id]);
  const p: any = post;
  const enriched = {
    id: p.id,
    author_email: p.author_email,
    author_name: p.author_name,
    title: p.title,
    body: p.body,
    pinned: p.pinned,
    created_at: p.created_at,
    attachments: p.attachments || [],
    like_count: embeddedCount(p.ja_community_likes),
    fav_count: embeddedCount(p.ja_community_favorites),
    liked_by_me: liked.has(id),
    faved_by_me: faved.has(id),
  };
  return { post: enriched, comments: comments ?? [] };
}

async function countReactions(table: string, postId: string): Promise<number> {
  const { count } = await supabase
    .from(table)
    .select("post_id", { count: "exact", head: true })
    .eq("post_id", postId);
  return count ?? 0;
}

/** Toggle a like on a post. `on=true` likes, `on=false` un-likes. Idempotent. */
export async function toggleLike(user: UserContext, postId: string, on: boolean) {
  const { data: post } = await supabase
    .from("ja_community_posts").select("id").eq("id", postId).maybeSingle();
  if (!post) return null; // post doesn't exist
  if (on) {
    const { error } = await supabase
      .from("ja_community_likes")
      .upsert(
        { post_id: postId, user_id: reactorId(user), user_email: user.email },
        { onConflict: "post_id,user_id", ignoreDuplicates: true },
      );
    if (error) throw new Error(`like failed: ${error.message}`);
  } else {
    const { error } = await supabase
      .from("ja_community_likes")
      .delete()
      .eq("post_id", postId)
      .eq("user_id", reactorId(user));
    if (error) throw new Error(`unlike failed: ${error.message}`);
  }
  return { liked: on, like_count: await countReactions("ja_community_likes", postId) };
}

/** Toggle a favorite on a post. `on=true` favorites, `on=false` un-favorites. */
export async function toggleFavorite(user: UserContext, postId: string, on: boolean) {
  const { data: post } = await supabase
    .from("ja_community_posts").select("id").eq("id", postId).maybeSingle();
  if (!post) return null;
  if (on) {
    const { error } = await supabase
      .from("ja_community_favorites")
      .upsert(
        { post_id: postId, user_id: reactorId(user), user_email: user.email },
        { onConflict: "post_id,user_id", ignoreDuplicates: true },
      );
    if (error) throw new Error(`favorite failed: ${error.message}`);
  } else {
    const { error } = await supabase
      .from("ja_community_favorites")
      .delete()
      .eq("post_id", postId)
      .eq("user_id", reactorId(user));
    if (error) throw new Error(`unfavorite failed: ${error.message}`);
  }
  return { faved: on, fav_count: await countReactions("ja_community_favorites", postId) };
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
