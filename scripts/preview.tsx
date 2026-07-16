/** Render ALL registry templates to static HTML for design review. Usage: npx tsx scripts/preview.tsx */
import { writeFileSync, mkdirSync } from 'node:fs';
import { renderTemplate, listTemplates } from '../src/templates/index.js';

mkdirSync('preview', { recursive: true });

const SAMPLE: Record<string, Record<string, unknown>> = {
  'rnb-vault/password-reset': { resetUrl: 'https://www.rnbvault.no/auth/update-password?token=preview' },
  'rnb-vault/magic-link': { magicUrl: 'https://www.rnbvault.no/auth/confirm?token=preview' },
  'rnb-vault/signup-confirm': { confirmUrl: 'https://www.rnbvault.no/auth/confirm?token=preview' },
  'rnb-vault/newsletter-welcome': { unsubscribeUrl: 'https://www.rnbvault.no/api/newsletter/unsubscribe?email=x' },
  'rnb-vault/event-approved': {
    event: { eventTitle: 'Sunday Soul Sessions', eventDate: 'Saturday 26 July 2026', venue: 'Blå', city: 'Oslo' },
    eventUrl: 'https://www.rnbvault.no/events/sunday-soul-sessions',
  },
  'rnb-vault/event-rejected': {
    event: { eventTitle: 'Techno Warehouse Rave', eventDate: 'Friday 1 August 2026', venue: 'Ukjent' },
    reason: "Event doesn't fit R&B/Soul/Neo-Soul genres",
    submitUrl: 'https://www.rnbvault.no/submit',
  },
  'rnb-vault/admin-notification': {
    event: { eventTitle: 'Sunday Soul Sessions', eventDate: 'Saturday 26 July 2026', venue: 'Blå', city: 'Oslo' },
    submitter: 'DJ Demure (demure@rnbvault.no)',
    reviewUrl: 'https://www.rnbvault.no/admin/events?highlight=123',
  },
};

for (const name of listTemplates()) {
  const { subject, html } = await renderTemplate(name, SAMPLE[name] ?? {});
  const file = `preview/${name.split('/')[1]}.html`;
  writeFileSync(file, html);
  console.log(`${file}  ←  "${subject}"`);
}
