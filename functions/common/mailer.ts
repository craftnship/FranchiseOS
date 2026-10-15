import { Mailer } from "./context";

// Notification email through Catalyst Mail. The sender address must be added and verified in the
// console (Cloud Scale > Mail) and named in FOS_MAIL_FROM; without it, notifications stay in-app.

interface CatalystMail { sendMail(config: { from_email: string; to_email: string[]; subject: string; content: string; html_mode: boolean }): Promise<unknown> }

export class CatalystMailer implements Mailer {
  constructor(private readonly mail: CatalystMail, private readonly from: string) {}
  async send(msg: { to: string; subject: string; html: string }): Promise<void> {
    await this.mail.sendMail({ from_email: this.from, to_email: [msg.to], subject: msg.subject, content: msg.html, html_mode: true });
  }
}

export function mailerFromEnv(app: unknown, env: NodeJS.ProcessEnv = process.env): Mailer | undefined {
  const from = env.FOS_MAIL_FROM?.trim();
  const email = (app as { email?: () => CatalystMail })?.email;
  return from && typeof email === "function" ? new CatalystMailer(email.call(app), from) : undefined;
}
