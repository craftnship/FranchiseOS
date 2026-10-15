// Catalyst Authentication user management, for inviting people from the admin screen.

export interface AuthAdmin {
  /** Registers the person in Catalyst Authentication, which emails them an invitation. Returns their Catalyst user id. */
  invite(user: { email: string; firstName: string; lastName: string }): Promise<{ externalUserId: string | null }>;
}

interface UserManagement {
  registerUser(signup: { platform_type: string; zaid: string; redirect_url?: string }, user: { email_id: string; first_name: string; last_name: string }): Promise<Record<string, unknown>>;
}

/** On once FOS_AUTH_ZAID holds the environment's ZAID (Settings → Environments; it differs between Development and Production). */
export function authAdminFromEnv(app: { userManagement(): UserManagement }): AuthAdmin | undefined {
  const zaid = process.env.FOS_AUTH_ZAID?.trim();
  if (!zaid) return undefined;
  const redirect = process.env.FOS_APP_URL?.trim();
  return {
    async invite(u) {
      const r = await app.userManagement().registerUser(
        { platform_type: "web", zaid, ...(redirect ? { redirect_url: redirect } : {}) },
        { email_id: u.email, first_name: u.firstName, last_name: u.lastName },
      );
      const details = (r.user_details ?? r) as Record<string, unknown>;
      const id = details.user_id ?? details.zuid;
      return { externalUserId: id ? String(id) : null };
    },
  };
}
