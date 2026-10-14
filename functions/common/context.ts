// Tenant context per spec §39. Always derived server-side from the authenticated identity (§6).
export interface TenantContext {
  tenantId: string;
  userId: string;
  roles: string[];
  zohoDc: string;
  requestId: string;
  correlationId: string;
  /** Set for portal users: the franchisee record they belong to (§25). */
  franchiseeId?: string;
  /** Set for staff limited to one region (regional managers): dashboards show only that region. */
  region?: string;
  /** Sends notification emails; absent when no sender is configured (inbox only). */
  mailer?: Mailer;
}

/**
 * The user to record on a row's *_by column: the signed-in user's id, or null when the actor is a job
 * ("SYSTEM:job"), since those columns are user foreign keys and the Data Store rejects anything but a number.
 */
export const actorId = (ctx: Pick<TenantContext, "userId">): string | null => (/^\d+$/.test(ctx.userId) ? ctx.userId : null);

export interface Mailer {
  send(msg: { to: string; subject: string; html: string; text: string }): Promise<void>;
}
