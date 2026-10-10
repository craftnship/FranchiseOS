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
  /** Sends notification emails; absent when no sender is configured (inbox only). */
  mailer?: Mailer;
}

export interface Mailer {
  send(msg: { to: string; subject: string; html: string; text: string }): Promise<void>;
}
