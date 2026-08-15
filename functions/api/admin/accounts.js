/**
 * /api/admin/accounts
 *   GET                                  -> list accounts (no secrets).
 *     Requires rank >= senior (Senior needs this to pick a target for
 *     assisted password resets). Owner rows are filtered out for
 *     everyone except the owner viewing their own row — see
 *     listAccounts()'s viewerUsername param in _shared/accounts.js.
 *   POST { action:"save", username, password?, role?, officeId?, allowedBrands?, allowedModules?, fullName?, pid? }
 *     What's allowed depends on the caller's rank AND what's actually
 *     changing — see the permission matrix below. Any field omitted from
 *     the body keeps its existing value (saveAccount uses patch/merge
 *     semantics).
 *   POST { action:"delete", username }   -> requires rank >= admin, and
 *     scoped the same way as create/reset below.
 *   POST { action:"lock"|"unlock", username, reason? } -> SuperAdmin AND
 *     ABOVE, scoped by canManage() same as everything else below — this
 *     used to be "any SuperAdmin can lock any other SuperAdmin", a real
 *     gap closed as part of introducing the Owner role (see
 *     OWNER_ROLE_SETUP.md). Manual override in either direction for the
 *     auto-lock feature in api/auth/login.js (5 consecutive wrong
 *     passwords, or 5 different unrecognized IPs within an hour, both
 *     lock the account automatically) — see that file's header for the
 *     full writeup.
 *
 * Permission matrix — ONE rule replaces what used to be a hand-written
 * per-rank allow-list (see OWNER_ROLE_SETUP.md for the full design):
 *
 *   actor can only manage a target STRICTLY ranked below the actor.
 *   Same rank can't manage same rank either (a SuperAdmin can't touch
 *   another SuperAdmin; only Owner can).
 *
 *   This one rule governs creating a new account with a given role, an
 *   assisted password-only reset targeting an existing account, deleting
 *   an account, and locking/unlocking an account — see canManage() below.
 *   - Editing role / officeId / allowedBrands / allowedModules on an
 *     EXISTING account: rank >= superadmin AND canManage() — EXCEPT the
 *     one-time SuperAdmin self-promotion bootstrap (an admin-or-above
 *     promoting THEIR OWN account to "superadmin", only while no
 *     superadmin exists anywhere yet).
 *   - Editing fullName / pid (profile fields) on an EXISTING account:
 *     rank >= admin AND (it's their own account OR canManage()).
 *   - "owner" can never be assigned through this endpoint, to anyone,
 *     by anyone — see the early rejection below and saveAccount()'s own
 *     independent enforcement in _shared/accounts.js.
 */
import { listAccounts, saveAccount, deleteAccount, getAccount, authenticateStaff, anySuperAdminExists, setAccountLocked, ROLE_RANK, rankOf, canSeeAdminSection, canEditAdminSection, canManageOthersAdminAccess } from "../../_shared/accounts.js";

// actor can only manage a target STRICTLY ranked below itself — same
// rank can't manage same rank (a SuperAdmin can't touch another
// SuperAdmin; only Owner, one tier above, can). Replaces the old
// hand-written MANAGE_SCOPE allow-list with a single comparison that
// naturally extends to any future rank added above without needing its
// own list entry.
function canManage(actorRank, targetRank) {
  return actorRank > targetRank;
}

// True when the target is an "owner" account and the actor isn't rank
// owner themselves — used to make owner accounts act as if they simply
// don't exist for everyone else (404, not 403, so a non-owner can't even
// tell the difference between "no such account" and "exists but you
// can't touch it").
function isHiddenTarget(target, actorRank) {
  return !!target && target.role === "owner" && actorRank < ROLE_RANK.owner;
}

export async function onRequestGet(context) {
  try {
    return await handleGet(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handleGet({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);
  const viewerUsername = auth.account?.role === "owner" ? auth.account.username : undefined;
  return json({ ok: true, accounts: await listAccounts(env, { viewerUsername }) });
}

export async function onRequestPost(context) {
  try {
    return await handlePost(context);
  } catch (e) {
    return json({ ok: false, error: `Unexpected server error: ${String(e && e.message || e)}` }, 500);
  }
}

async function handlePost({ request, env }) {
  if (!env.THREADS_KV) return json({ ok: false, error: "THREADS_KV is not bound yet." }, 500);
  const auth = await authenticateStaff(request, env, ROLE_RANK.senior);
  if (!auth.ok) return json({ ok: false, error: "Not authorized." }, 401);

  let body;
  try {
    body = await request.json();
  } catch {
    return json({ ok: false, error: "Invalid JSON body." }, 400);
  }

  // Bootstrap mode (no real account yet) is treated as superadmin-rank
  // for this one-time setup call — same trust level BRAND_EDIT_PASSWORD
  // already had before any of this existed.
  const actorRank = auth.account ? rankOf(auth.account.role) : ROLE_RANK.superadmin;
  const actorUsername = auth.account ? auth.account.username : null;

  // No path through this endpoint can ever produce an "owner" account —
  // checked immediately, before anything else even looks at the body.
  // saveAccount() itself independently refuses this too (see
  // _shared/accounts.js) — this early rejection is just a clearer error
  // message for that same, non-negotiable rule.
  if (body.action === "save" && body.role === "owner") {
    return json({ ok: false, error: "The Owner role cannot be assigned through this interface." }, 403);
  }

  // "Can manage Account Management Access for other accounts" — the
  // delegation flag itself — can only ever be granted/revoked by the
  // real Owner. If a delegated (non-owner) account could flip this flag,
  // they could hand the same power to themselves or anyone else, which
  // would defeat the entire point of it being Owner-controlled.
  if (body.action === "save" && body.canGrantAdminAccess !== undefined && auth.account?.role !== "owner") {
    return json({ ok: false, error: 'Only the Owner can grant or revoke "Can manage Account Management Access for other accounts".' }, 403);
  }

  if (body.action === "save") {
    if (!body.username) return json({ ok: false, error: "Username is required." }, 400);
    const targetUsername = body.username.toLowerCase();
    const existingTarget = await getAccount(env, targetUsername);

    if (isHiddenTarget(existingTarget, actorRank)) {
      return json({ ok: false, error: "Account not found." }, 404); // 404, not 403 — see isHiddenTarget()'s own comment
    }

    // Account Management Access itself (which sections a target account
    // can see/edit) can only be changed by the Owner, or by an account
    // the Owner has explicitly delegated this to via canGrantAdminAccess
    // (see canManageOthersAdminAccess()) — and even then, only for a
    // target ranked STRICTLY below the actor, same rule as every other
    // cross-account action below (a delegated SuperAdmin still can't
    // touch another SuperAdmin; only the real Owner can).
    if (body.allowedAdminSections !== undefined || body.adminSectionEditAccess !== undefined) {
      if (!canManageOthersAdminAccess(auth.account)) {
        return json({ ok: false, error: "You don't have permission to change Account Management Access." }, 403);
      }
      if (existingTarget && !canManage(actorRank, rankOf(existingTarget.role))) {
        return json({ ok: false, error: "You can only change Account Management Access for accounts ranked below your own." }, 403);
      }
    }

    // Owner Topics ("Topic access" list — Announcements / Active Agents).
    // STRICTLY the real Owner, unlike allowedAdminSections above — no
    // canGrantAdminAccess delegation here on purpose (see OWNER_TOPIC_ITEMS
    // in _shared/accounts.js). Still scoped to targets ranked below the
    // actor, same as everywhere else, even though for a real Owner that's
    // always true (owner outranks everyone) — kept for consistency/
    // future-proofing if that ever stops being trivially true.
    if (body.ownerTopicAccess !== undefined) {
      if (auth.account?.role !== "owner") {
        return json({ ok: false, error: "Only the Owner can change Topic access for Announcements or Active Agents." }, 403);
      }
      if (existingTarget && !canManage(actorRank, rankOf(existingTarget.role))) {
        return json({ ok: false, error: "You can only change Topic access for accounts ranked below your own." }, 403);
      }
    }

    if (!existingTarget) {
      // ---- Creating a brand-new account ----
      if (!canSeeAdminSection(auth.account, "createAccount")) {
        return json({ ok: false, error: "You don't have Create Account access." }, 403);
      }
      const requestedRole = body.role || "agent";
      if (!canManage(actorRank, rankOf(requestedRole))) {
        return json({ ok: false, error: "You can only create accounts with a role lower than your own." }, 403);
      }
    } else {
      // ---- Editing an existing account ----
      const targetRank = rankOf(existingTarget.role);
      // Compare against the ACTUAL existing values, not just "was this
      // field present in the body" — accounts-admin.html's form always
      // resubmits every field (officeId, allowedBrands, fullName, pid)
      // whether or not the person actually touched it, so "field present"
      // would wrongly count as "changing" even when the value is
      // identical. This matters a lot for the SuperAdmin self-promotion
      // bootstrap below, which requires ONLY role to be changing.
      const roleChanging = body.role !== undefined && body.role !== existingTarget.role;
      const profileChanging =
        (body.fullName !== undefined && body.fullName !== (existingTarget.fullName || "")) ||
        (body.pid !== undefined && body.pid !== (existingTarget.pid || ""));
      const accessChanging =
        (body.officeId !== undefined && (body.officeId || null) !== (existingTarget.officeId || null)) ||
        (body.allowedBrands !== undefined && JSON.stringify(body.allowedBrands) !== JSON.stringify(existingTarget.allowedBrands ?? [])) ||
        (body.allowedModules !== undefined && JSON.stringify(body.allowedModules) !== JSON.stringify(existingTarget.allowedModules ?? "all"));
      const passwordChanging = !!body.password;
      const isSelf = actorUsername === targetUsername;

      if (roleChanging || accessChanging) {
        const isSelfPromotionToSuperAdmin =
          isSelf &&
          body.role === "superadmin" &&
          !accessChanging &&
          actorRank >= ROLE_RANK.admin;
        const superAdminAlreadyExists = await anySuperAdminExists(env);
        const hasAuthority = canEditAdminSection(auth.account, "agentProfile") && canManage(actorRank, targetRank);

        if (!hasAuthority && !(isSelfPromotionToSuperAdmin && !superAdminAlreadyExists)) {
          return json({ ok: false, error: "You can only change role, office, brand access, or topic access for accounts ranked below your own." }, 403);
        }
      }
      // Editing your OWN profile fields is a basic self-service right,
      // unrelated to Account Management Access — untouched by this layer.
      // Editing someone ELSE's requires agentProfile Can-Edit + outranking them.
      const othersProfileOk = !isSelf && canEditAdminSection(auth.account, "agentProfile") && canManage(actorRank, targetRank);
      if (profileChanging && !(isSelf ? actorRank >= ROLE_RANK.admin : othersProfileOk)) {
        return json({ ok: false, error: "You can only edit profile fields for your own account, or accounts ranked below your own (with Can-Edit access to Agent Profile)." }, 403);
      }
      if (passwordChanging && !roleChanging && !accessChanging) {
        // Password-only change on someone else's account (an assisted reset).
        if (!isSelf && !(canEditAdminSection(auth.account, "agentProfile") && canManage(actorRank, targetRank))) {
          return json({ ok: false, error: "You can only reset a password for accounts ranked below your own (with Can-Edit access to Agent Profile)." }, 403);
        }
      }
    }

    try {
      const account = await saveAccount(env, {
        username: body.username,
        password: body.password || undefined,
        passwordChangedBy: body.password ? (actorUsername || "bootstrap-setup") : undefined,
        role: body.role !== undefined ? body.role : undefined,
        officeId: body.officeId !== undefined ? (body.officeId || null) : undefined,
        allowedBrands: body.allowedBrands !== undefined ? body.allowedBrands : undefined,
        allowedModules: body.allowedModules !== undefined ? body.allowedModules : undefined,
        allowedAdminSections: body.allowedAdminSections !== undefined ? body.allowedAdminSections : undefined,
        adminSectionEditAccess: body.adminSectionEditAccess !== undefined ? body.adminSectionEditAccess : undefined,
        canGrantAdminAccess: body.canGrantAdminAccess !== undefined ? !!body.canGrantAdminAccess : undefined,
        ownerTopicAccess: body.ownerTopicAccess !== undefined ? body.ownerTopicAccess : undefined,
        fullName: body.fullName !== undefined ? body.fullName : undefined,
        pid: body.pid !== undefined ? body.pid : undefined,
      });
      return json({ ok: true, account });
    } catch (e) {
      return json({ ok: false, error: String(e.message || e) }, 400);
    }
  }

  if (body.action === "delete") {
    if (actorRank < ROLE_RANK.admin) return json({ ok: false, error: "Not authorized." }, 403); // Senior has no delete access at all
    if (!canEditAdminSection(auth.account, "agentProfile")) return json({ ok: false, error: "You don't have Can-Edit access to Agent Profile." }, 403);
    if (!body.username) return json({ ok: false, error: "Missing username." }, 400);
    const target = await getAccount(env, body.username);
    if (isHiddenTarget(target, actorRank)) return json({ ok: false, error: "Account not found." }, 404);
    if (target && !canManage(actorRank, rankOf(target.role))) {
      return json({ ok: false, error: "You can only delete accounts ranked below your own." }, 403);
    }
    await deleteAccount(env, body.username);
    return json({ ok: true });
  }

  if (body.action === "lock" || body.action === "unlock") {
    // Manual lock/unlock — used to be "any SuperAdmin can lock any other
    // SuperAdmin", a real gap (SuperAdmins could lock each other out)
    // closed here by the same canManage() rule everything else uses,
    // instead of a flat "just be SuperAdmin" check. Still requires rank
    // >= superadmin as a floor — Admin/Senior still can't lock anyone,
    // same as before.
    if (!body.username) return json({ ok: false, error: "Missing username." }, 400);
    const target = await getAccount(env, body.username);
    if (isHiddenTarget(target, actorRank)) return json({ ok: false, error: "Account not found." }, 404);
    if (!target) return json({ ok: false, error: "Account not found." }, 404);
    if (!(canEditAdminSection(auth.account, "agentProfile") && canManage(actorRank, rankOf(target.role)))) {
      return json({ ok: false, error: "You can only lock or unlock accounts ranked below your own (with Can-Edit access to Agent Profile)." }, 403);
    }
    // (Rank floor itself no longer applies here — Can-Edit access to Agent
    // Profile is now the gate, same as everything else in this file that
    // touches an existing account. See ACCOUNT_MGMT_VIEW_EDIT_LEVEL_SETUP.md.)
    const locked = body.action === "lock";
    const account = await setAccountLocked(env, body.username, locked, locked ? (body.reason || `Manually locked by ${actorUsername}`) : null);
    return json({ ok: true, account });
  }

  return json({ ok: false, error: `Unknown action "${body.action}".` }, 400);
}

function json(obj, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { "Content-Type": "application/json", "Cache-Control": "no-store" } });
}
