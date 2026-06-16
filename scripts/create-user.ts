/**
 * Create (or update) a user and mint an API key.
 *
 *   npm run create-key -- --email a@b.com --name "Jane" --groups NUS,SMU
 *   npm run create-key -- --email admin@b.com --admin
 *   npm run create-key -- --email a@b.com           # mint another key for an existing user
 *
 * The raw API key is printed ONCE — store it now, it cannot be recovered.
 */
import { supabase } from "../src/supabase.js";
import { generateApiKey } from "../src/auth.js";

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 ? process.argv[i + 1] : undefined;
}
function flag(name: string): boolean {
  return process.argv.includes(`--${name}`);
}

async function main() {
  const email = arg("email");
  if (!email) {
    console.error("Usage: npm run create-key -- --email <email> [--name <name>] [--groups A,B] [--admin] [--label <label>] [--scopes query:daily]");
    process.exit(1);
  }
  const name = arg("name") ?? null;
  const groups = (arg("groups") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);
  const isAdmin = flag("admin");
  const label = arg("label") ?? "cli";
  const scopes = (arg("scopes") ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean);

  // Upsert the user by email.
  const { data: user, error: userErr } = await supabase
    .from("ja_users")
    .upsert(
      {
        email,
        name,
        access_groups: groups,
        is_admin: isAdmin,
      },
      { onConflict: "email" },
    )
    .select("id, email, name, access_groups, is_admin")
    .single();

  if (userErr || !user) {
    console.error("Failed to upsert user:", userErr?.message);
    process.exit(1);
  }

  const { raw, hash, prefix } = generateApiKey();
  const { error: keyErr } = await supabase.from("ja_api_keys").insert({
    user_id: user.id,
    key_hash: hash,
    key_prefix: prefix,
    key_plain: raw, // stored so the admin backend can re-copy it (migration 0011)
    label,
    scopes,
  });
  if (keyErr) {
    console.error("Failed to insert api key:", keyErr.message);
    process.exit(1);
  }

  console.log("\n✅ User ready:");
  console.log(`   email        : ${user.email}`);
  console.log(`   name         : ${user.name ?? "(none)"}`);
  console.log(`   access_groups: ${(user.access_groups ?? []).join(", ") || "(none)"}`);
  console.log(`   is_admin     : ${user.is_admin}`);
  console.log(`   scopes       : ${scopes.join(", ") || "(none)"}`);
  console.log("\n🔑 API key (shown once — copy it now):\n");
  console.log(`   ${raw}\n`);
  console.log("   Use it as:  Authorization: Bearer " + raw + "\n");
  process.exit(0);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
