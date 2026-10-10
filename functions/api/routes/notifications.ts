import { z } from "zod";
import { AppError } from "../../common/errors";
import { parse, Router } from "../router";

const listSchema = z.object({ unread: z.enum(["true", "false"]).optional(), limit: z.coerce.number().int().min(1).max(100).default(30) });

/** The caller's own inbox (any signed-in user; rows are always filtered to the caller). */
export function notificationRoutes(r: Router): void {
  r.on("GET", "/notifications", null, async (call) => {
    const q = parse(listSchema, call.query);
    const mine = { recipient_user_id: call.ctx.userId };
    const items = await call.repo.findMany("notifications", { ...mine, ...(q.unread === "true" ? { status: "UNREAD" } : {}) }, { orderBy: "created_at", desc: true, limit: q.limit });
    const unread = (await call.repo.findMany("notifications", { ...mine, status: "UNREAD" }, { limit: 100 })).length;
    return { items, unread };
  });

  r.on("POST", "/notifications/:id/read", null, async (call) => {
    const n = await call.repo.findOne("notifications", { ROWID: call.params.id, recipient_user_id: call.ctx.userId });
    if (!n) throw new AppError("NOT_FOUND", "Notification not found.");
    return n.status === "READ" ? n : call.repo.update("notifications", call.params.id, { status: "READ", read_at: call.now.toISOString() });
  });

  r.on("POST", "/notifications/read-all", null, async (call) => {
    const open = await call.repo.findMany("notifications", { recipient_user_id: call.ctx.userId, status: "UNREAD" }, { limit: 300 });
    for (const n of open) await call.repo.update("notifications", String(n.ROWID), { status: "READ", read_at: call.now.toISOString() });
    return { read: open.length };
  });
}
