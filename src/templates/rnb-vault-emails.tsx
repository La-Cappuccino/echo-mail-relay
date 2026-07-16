/** rnb-vault product emails — newsletter welcome + event workflow (replaces the legacy purple-gradient set). */
import { Link, Section, Text } from '@react-email/components';
import * as React from 'react';
import {
  VaultEmailLayout,
  VaultButton,
  headingStyle,
  bodyStyle,
  mutedStyle,
  SUNDAY,
  FONT_MONO,
} from './vault-layout.js';

const SITE = 'https://www.rnbvault.no';

function DetailRow({ label, value }: { label: string; value: string }) {
  return (
    <tr>
      <td
        style={{
          fontFamily: FONT_MONO,
          fontSize: '10px',
          letterSpacing: '0.14em',
          textTransform: 'uppercase' as const,
          color: SUNDAY.muted,
          padding: '6px 16px 6px 0',
          verticalAlign: 'top',
          whiteSpace: 'nowrap' as const,
        }}
      >
        {label}
      </td>
      <td style={{ ...({} as object), fontFamily: "'Plus Jakarta Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif", fontSize: '14px', lineHeight: '21px', color: SUNDAY.ink, padding: '6px 0' }}>
        {value}
      </td>
    </tr>
  );
}

export function EventDetails({ rows }: { rows: Array<{ label: string; value: string }> }) {
  return (
    <Section
      style={{
        backgroundColor: SUNDAY.cream,
        borderRadius: '12px',
        padding: '16px 20px',
        margin: '18px 0',
      }}
    >
      <table role="presentation" cellPadding={0} cellSpacing={0} style={{ width: '100%' }}>
        <tbody>
          {rows.map((r) => (
            <DetailRow key={r.label} label={r.label} value={r.value} />
          ))}
        </tbody>
      </table>
    </Section>
  );
}

export function NewsletterWelcomeEmail({ unsubscribeUrl }: { unsubscribeUrl: string }) {
  return (
    <VaultEmailLayout
      preview="You're in — weekly R&B culture from Oslo."
      eyebrow="Newsletter"
      footerNote="You subscribed to the RnB Vault newsletter."
    >
      <Text style={headingStyle}>You&apos;re in the Vault.</Text>
      <Text style={bodyStyle}>
        Expect quiz challenges, curated playlists, Oslo event drops and R&amp;B culture —
        straight to this inbox, no noise.
      </Text>
      <VaultButton href={SITE}>Start exploring</VaultButton>
      <Text style={mutedStyle}>
        Not for you?{' '}
        <Link href={unsubscribeUrl} style={{ color: SUNDAY.muted, textDecoration: 'underline' }}>
          Unsubscribe here
        </Link>
        .
      </Text>
    </VaultEmailLayout>
  );
}

export interface EventData {
  eventTitle: string;
  eventDate: string;
  venue: string;
  city?: string;
}

export function EventApprovedEmail({ event, eventUrl }: { event: EventData; eventUrl: string }) {
  return (
    <VaultEmailLayout
      preview={`"${event.eventTitle}" is approved and live on RnB Vault.`}
      eyebrow="Event approved"
      footerNote="You received this because you submitted an event to RnB Vault."
    >
      <Text style={headingStyle}>It&apos;s live.</Text>
      <Text style={bodyStyle}>
        Your event is approved and now visible to the Oslo R&amp;B community.
      </Text>
      <EventDetails
        rows={[
          { label: 'Event', value: event.eventTitle },
          { label: 'Date', value: event.eventDate },
          { label: 'Venue', value: `${event.venue}${event.city ? ', ' + event.city : ''}` },
        ]}
      />
      <VaultButton href={eventUrl}>View your event</VaultButton>
    </VaultEmailLayout>
  );
}

export function EventRejectedEmail({
  event,
  reason,
  submitUrl,
}: {
  event: EventData;
  reason?: string;
  submitUrl: string;
}) {
  return (
    <VaultEmailLayout
      preview="Update on your RnB Vault event submission."
      eyebrow="Submission update"
      footerNote="You received this because you submitted an event to RnB Vault."
    >
      <Text style={headingStyle}>Not this one.</Text>
      <Text style={bodyStyle}>
        Thanks for submitting — after review we couldn&apos;t approve this event
        {reason ? ':' : '.'}
      </Text>
      {reason ? <Text style={{ ...bodyStyle, color: SUNDAY.muted }}>&ldquo;{reason}&rdquo;</Text> : null}
      <EventDetails
        rows={[
          { label: 'Event', value: event.eventTitle },
          { label: 'Date', value: event.eventDate },
          { label: 'Venue', value: event.venue },
        ]}
      />
      <Text style={bodyStyle}>
        Most rejections are genre fit or incomplete details — future events are always
        welcome.
      </Text>
      <VaultButton href={submitUrl}>Submit another event</VaultButton>
    </VaultEmailLayout>
  );
}

export function AdminNotificationEmail({
  event,
  submitter,
  reviewUrl,
}: {
  event: EventData;
  submitter: string;
  reviewUrl: string;
}) {
  return (
    <VaultEmailLayout
      preview={`New event submission: ${event.eventTitle}`}
      eyebrow="New submission"
      footerNote="Automated notification from the RnB Vault admin system."
    >
      <Text style={headingStyle}>New event awaiting review.</Text>
      <EventDetails
        rows={[
          { label: 'Event', value: event.eventTitle },
          { label: 'Date', value: event.eventDate },
          { label: 'Venue', value: `${event.venue}${event.city ? ', ' + event.city : ''}` },
          { label: 'From', value: submitter },
        ]}
      />
      <VaultButton href={reviewUrl}>Review submission</VaultButton>
    </VaultEmailLayout>
  );
}
