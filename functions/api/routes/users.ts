import { z } from "zod";
import { logActivity } from "../../common/audit";
import { pendingKey } from "../../common/directory";
import { AppError } from "../../common/errors";
import { log } from "../../common/logger";
import { ROLES } from "../../common/rbac";
import { Row } from "../../common/store";
import { Call, parse, Router } from "../router";
import { checkRegion } from "./regions";
import { fetchAll } from "./shared";

// User and role administration for the caller's tenant (user.admin; SUPER_ADMIN by default).

const PORTAL_ROLES = new Set(["FRANCHISEE", "FRANCHISEE_STAFF"]);
const role = z.enum(ROLES);
const createSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(200),
  name: z.string().trim().min(1).max(120),
  role,
  franchisee_id: z.string().max(40).nullish(),
  region: z.string().trim().max(60).nullish(),
});
const changeSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  role: role.optional(),
  franchisee_id: z.string().max(40).nullable().optional(),
  region: z.string().trim().max(60).nullable().optional(),
  status: z.enum(["ACTIVE", "INACTIVE"]).optional(),
}).refine((b) => Object.keys(b).length > 0, { message: "Nothing to change." });

async function rolesByCode(call: Call): Promise<Map<string, Row>> {
  return new Map((await call.repo.findMany("roles", {}, { limit: 100 })).map((r) => [String(r.code), r]));
}

/** A franchisee link is required for portal roles and refused for staff roles. */
/** Only a super admin can make, demote or deactivate another super admin, whoever else holds user.admin. */
function onlyAdminsMakeAdmins(call: Call, role: string): void {
  if (role === "SUPER_ADMIN" && !call.ctx.roles.includes("SUPER_ADMIN")) throw new AppError("ACCESS_DENIED", "Only a super admin can change super admins.");
}

async function checkFranchisee(call: Call, roleCode: string, franchiseeId: string | null | undefined): Promise<void> {
  if (PORTAL_ROLES.has(roleCode)) {
    if (!franchiseeId) throw new AppError("VALIDATION_FAILED", "Franchisee users need a franchisee.", { franchisee_id: "required for this role" });
    if (!await call.repo.findOne("franchisees", { ROWID: franchiseeId })) throw new AppError("VALIDATION_FAILED", "Franchisee not found.", { franchisee_id: "not found" });
  } else if (franchiseeId) {
    throw new AppError("VALIDATION_FAILED", "Only franchisee users are linked to a franchisee.", { franchisee_id: "only for franchisee roles" });
  }
}

/** Staff can be limited to one region (dashboards show only it); a regional manager must be. */
async function checkUserRegion(call: Call, roleCode: string, region: string | null | undefined): Promise<string | null> {
  const portal = PORTAL_ROLES.has(roleCode) || roleCode === "VENDOR";
  if (portal && region) throw new AppError("VALIDATION_FAILED", "Franchisee and vendor users aren't limited by region.", { region: "only for staff roles" });
  if (roleCode === "REGIONAL_MANAGER" && !region?.trim()) throw new AppError("VALIDATION_FAILED", "Regional managers need a region.", { region: "required for this role" });
  return portal ? null : checkRegion(call, region);
}

function view(u: Row, roles: Map<string, Row>, franchisees: Map<string, Row>): Row {
  const r = [...roles.values()].find((x) => String(x.ROWID) === String(u.role_id));
  const f = u.franchisee_id ? franchisees.get(String(u.franchisee_id)) : null;
  return {
    id: String(u.ROWID), name: u.name ?? null, email: u.email, status: u.status, role: r?.code ?? null,
    franchisee: f ? { id: String(f.ROWID), name: f.display_name ?? f.franchise_code } : null,
    region: u.region ?? null,
    // Signed in at least once: the row carries their Catalyst user id rather than an invite key.
    signed_in: u.status !== "INVITED",
    created_at: u.CREATEDTIME ?? null,
  };
}

export function userRoutes(r: Router): void {
  r.on("GET", "/admin/users", "user.admin", async (call) => {
    const [users, roles, franchisees, perms] = await Promise.all([
      call.repo.findMany("users", {}), rolesByCode(call),
      call.repo.findMany("franchisees", {}), call.repo.findMany("role_permissions", {}),
    ]);
    const fmap = new Map(franchisees.map((f) => [String(f.ROWID), f]));
    const byRole = new Map<string, string[]>();
    for (const p of perms) byRole.set(String(p.role_id), [...(byRole.get(String(p.role_id)) ?? []), String(p.permission_code)]);
    const counts = new Map<string, number>();
    for (const u of users) if (u.status === "ACTIVE") counts.set(String(u.role_id), (counts.get(String(u.role_id)) ?? 0) + 1);
    return {
      users: users.map((u) => view(u, roles, fmap)).sort((a, b) => String(a.name ?? a.email).localeCompare(String(b.name ?? b.email))),
      roles: ROLES.filter((c) => roles.has(c)).map((c) => {
        const row = roles.get(c)!;
        return { code: c, name: row.name ?? c, permissions: c === "SUPER_ADMIN" ? ["*"] : (byRole.get(String(row.ROWID)) ?? []).sort(), active_users: counts.get(String(row.ROWID)) ?? 0, portal: PORTAL_ROLES.has(c) || c === "VENDOR" };
      }),
      franchisees: franchisees.map((f) => ({ id: String(f.ROWID), name: f.display_name ?? f.franchise_code })),
      regions: [...new Set((await fetchAll(call.repo, "territories")).map((t) => String(t.region ?? "").trim()).filter(Boolean))].sort(),
      invites_by_email: !!call.auth,
    };
  });

  r.on("POST", "/admin/users", "user.admin", async (call) => {
    const b = parse(createSchema, call.body);
    const roles = await rolesByCode(call);
    const roleRow = roles.get(b.role);
    if (!roleRow) throw new AppError("VALIDATION_FAILED", "Unknown role.", { role: "not set up for this tenant" });
    onlyAdminsMakeAdmins(call, b.role);
    await checkFranchisee(call, b.role, b.franchisee_id);
    const region = await checkUserRegion(call, b.role, b.region);
    const existing = (await call.repo.findMany("users", { email: b.email }, { limit: 5 })).concat(await call.store.findMany("users", { external_user_id: pendingKey(b.email) }, { limit: 1 }));
    if (existing.length) throw new AppError("VALIDATION_FAILED", "Someone with this email already has a FranchiseOS account.", { email: "already added" });
    // Catalyst sends the invitation email when invites are on; otherwise the person signs up or is
    // added in the Catalyst console, and is linked by their verified email on first sign-in.
    let externalUserId = pendingKey(b.email);
    let invited = false;
    if (call.auth) {
      const [first, ...rest] = b.name.split(/\s+/);
      try {
        const res = await call.auth.invite({ email: b.email, firstName: first, lastName: rest.join(" ") || first });
        if (res.externalUserId) externalUserId = res.externalUserId;
        invited = true;
      } catch (e) {
        // Usually the person already has a Catalyst account; the email link still works.
        log("warn", "user.invite_failed", { request_id: call.ctx.requestId, error: String((e as Error)?.message ?? e).slice(0, 300) });
      }
    }
    const row = await call.repo.insert("users", { email: b.email, name: b.name, status: "INVITED", role_id: String(roleRow.ROWID), external_user_id: externalUserId, franchisee_id: b.franchisee_id ?? null, region });
    await logActivity(call.store, call.ctx, { entityType: "user", entityId: String(row.ROWID), action: "user:invited", metadata: { email: b.email, role: b.role, franchisee_id: b.franchisee_id ?? null, region, email_sent: invited } });
    const franchisees = new Map((await call.repo.findMany("franchisees", {})).map((f) => [String(f.ROWID), f]));
    return { user: view(row, roles, franchisees), email_sent: invited };
  }, 201);

  r.on("PATCH", "/admin/users/:id", "user.admin", async (call) => {
    const b = parse(changeSchema, call.body);
    const user = await call.repo.findOne("users", { ROWID: call.params.id });
    if (!user) throw new AppError("NOT_FOUND", "User not found.");
    const roles = await rolesByCode(call);
    const current = [...roles.values()].find((x) => String(x.ROWID) === String(user.role_id));
    const nextRole = b.role ?? String(current?.code ?? "");
    const nextFranchisee = b.franchisee_id !== undefined ? b.franchisee_id : (PORTAL_ROLES.has(nextRole) || nextRole === "VENDOR" ? (user.franchisee_id as string | null) : null);
    if (b.role && !roles.has(b.role)) throw new AppError("VALIDATION_FAILED", "Unknown role.", { role: "not set up for this tenant" });
    if (b.role && b.role !== current?.code) onlyAdminsMakeAdmins(call, b.role);
    await checkFranchisee(call, nextRole, nextFranchisee);
    const nextRegion = await checkUserRegion(call, nextRole, b.region !== undefined ? b.region : (user.region as string | null));
    const self = String(user.ROWID) === call.ctx.userId;
    if (current?.code === "SUPER_ADMIN" && !self && (b.role || b.status)) onlyAdminsMakeAdmins(call, "SUPER_ADMIN");
    if (self && (b.status === "INACTIVE" || (b.role && b.role !== current?.code))) {
      throw new AppError("VALIDATION_FAILED", "You can't deactivate yourself or change your own role.", { [b.status ? "status" : "role"]: "not on your own account" });
    }
    const losingAdmin = current?.code === "SUPER_ADMIN" && user.status === "ACTIVE" && (b.status === "INACTIVE" || (b.role && b.role !== "SUPER_ADMIN"));
    if (losingAdmin) {
      const admins = await call.repo.findMany("users", { role_id: String(current!.ROWID), status: "ACTIVE" }, { limit: 5 });
      if (admins.length <= 1) throw new AppError("VALIDATION_FAILED", "This is the last active super admin.", { role: "keep at least one super admin" });
    }
    if (b.status === "ACTIVE" && user.status === "INVITED") throw new AppError("VALIDATION_FAILED", "Invited people become active when they first sign in.", { status: "waiting for first sign-in" });
    const patch: Row = {};
    const changes: Row = {};
    if (b.name !== undefined && b.name !== user.name) { patch.name = b.name; changes.name = { from: user.name ?? null, to: b.name }; }
    if (b.role && b.role !== current?.code) { patch.role_id = String(roles.get(b.role)!.ROWID); changes.role = { from: current?.code ?? null, to: b.role }; }
    if (String(nextFranchisee ?? "") !== String(user.franchisee_id ?? "")) { patch.franchisee_id = nextFranchisee ?? null; changes.franchisee_id = { from: user.franchisee_id ?? null, to: nextFranchisee ?? null }; }
    if (String(nextRegion ?? "") !== String(user.region ?? "")) { patch.region = nextRegion; changes.region = { from: user.region ?? null, to: nextRegion }; }
    // Reactivating an invite that never signed in puts it back to INVITED.
    if (b.status && b.status !== user.status && !(user.status === "INVITED" && b.status === "ACTIVE")) {
      const to = b.status === "ACTIVE" && String(user.external_user_id).startsWith("invite:") ? "INVITED" : b.status;
      if (to !== user.status) { patch.status = to; changes.status = { from: user.status, to }; }
    }
    const updated = Object.keys(patch).length ? await call.repo.update("users", String(user.ROWID), patch) : user;
    if (Object.keys(changes).length) {
      const action = changes.status ? (patch.status === "INACTIVE" ? "user:deactivated" : "user:reactivated") : "user:updated";
      await logActivity(call.store, call.ctx, { entityType: "user", entityId: String(user.ROWID), action, metadata: { email: user.email, ...changes } });
    }
    const franchisees = new Map((await call.repo.findMany("franchisees", {})).map((f) => [String(f.ROWID), f]));
    return view({ ...user, ...updated }, roles, franchisees);
  });
}
