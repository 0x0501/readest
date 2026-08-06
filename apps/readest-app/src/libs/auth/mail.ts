import { getCloudflareContext } from '@opennextjs/cloudflare';

export interface MailMessage {
  to: string;
  subject: string;
  text: string;
  html: string;
}

export type SendMail = (message: MailMessage) => Promise<void>;

/**
 * Minimal local typing for the Cloudflare Email Sending binding. The project does
 * not depend on `@cloudflare/workers-types`; `src/libs/db/index.ts` types the
 * Hyperdrive binding the same way.
 */
interface EmailBinding {
  send(message: {
    to: string | string[];
    from: { email: string; name?: string };
    subject: string;
    text?: string;
    html?: string;
  }): Promise<{ messageId: string }>;
}

interface CloudflareEnv {
  EMAIL?: EmailBinding;
}

/**
 * Build the sender for one request (ADR-016).
 *
 * The binding is read here — while the auth instance is being constructed, which
 * happens inside the request — and closed over by the returned function. Better
 * Auth delivers reset mail through `runInBackgroundOrAwait`, which on Workers can
 * mean `waitUntil`, and `getCloudflareContext()` reads async-local storage that is
 * no longer in scope by then.
 *
 * Outside the Worker runtime there is no binding and no error: `next dev` and the
 * tests get a sender that writes the message to the log instead. That is what
 * makes the reset flow exercisable without deploying, and it is why a missing
 * `AUTH_EMAIL_FROM` in production is caught by `check-env-prod` rather than by
 * the first person to forget their password.
 */
export const createMailer = (): SendMail => {
  let binding: EmailBinding | undefined;
  try {
    binding = (getCloudflareContext().env as Partial<CloudflareEnv> | undefined)?.EMAIL;
  } catch {
    // getCloudflareContext throws outside the Worker runtime.
  }
  const from = process.env['AUTH_EMAIL_FROM'];

  if (!binding || !from) {
    return async ({ to, subject, text }) => {
      console.info(`[auth] mail not configured, would have sent to ${to}: ${subject}\n${text}`);
    };
  }

  return async ({ to, subject, text, html }) => {
    await binding.send({ to, from: { email: from, name: 'Readest' }, subject, text, html });
  };
};
