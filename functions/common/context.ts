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
}
