/**
 * VaultEmailLayout — RnB Vault email shell, Sunday theme.
 *
 * Design source: rnb-vault/src/app/globals.css [data-theme="sunday"] +
 * docs/design/DESIGN-SYSTEM.md. Email-safe translation:
 *  - cream page #F2F0E9, white card radius 16, near-black ink #0D0D0D
 *  - single accent: orange #FF6B35 (CTA + links only — no gradients)
 *  - wordmark: 900 italic (Plus Jakarta Sans → Helvetica/Arial fallback)
 *  - eyebrow/footer: mono uppercase (JetBrains Mono → Courier fallback)
 * Layout must survive images-off (text wordmark carries identity; the
 * keyhole logo img is enhancement only).
 */
import {
  Body,
  Container,
  Head,
  Hr,
  Html,
  Img,
  Link,
  Preview,
  Section,
  Text,
} from '@react-email/components';
import * as React from 'react';

export const SUNDAY = {
  cream: '#F2F0E9',
  card: '#FFFFFF',
  ink: '#0D0D0D',
  muted: '#6F6A60',
  orange: '#FF6B35',
  border: '#E5E1D8',
};

export const FONT_HEADING =
  "'Plus Jakarta Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif";
export const FONT_BODY =
  "'Plus Jakarta Sans', 'Helvetica Neue', Helvetica, Arial, sans-serif";
export const FONT_MONO = "'JetBrains Mono', 'Courier New', Courier, monospace";

const SITE = 'https://www.rnbvault.no';
const LOGO = `${SITE}/icons/icon-96x96.png`;

export function VaultEmailLayout({
  preview,
  eyebrow,
  children,
  footerNote,
}: {
  preview: string;
  eyebrow: string;
  children: React.ReactNode;
  footerNote?: string;
}) {
  return (
    <Html lang="en">
      <Head>
        {/* Real font where supported (Apple Mail etc.); Helvetica bold-italic fallback elsewhere */}
        <link
          href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:ital,wght@0,400;0,600;1,800&display=swap"
          rel="stylesheet"
        />
      </Head>
      <Preview>{preview}</Preview>
      <Body style={{ backgroundColor: SUNDAY.cream, margin: 0, padding: 0 }}>
        <Container style={{ maxWidth: '560px', margin: '0 auto', padding: '32px 16px' }}>
          {/* Wordmark bar — text-first so identity survives images-off */}
          <Section style={{ padding: '8px 4px 20px' }}>
            <table role="presentation" cellPadding={0} cellSpacing={0}>
              <tbody>
                <tr>
                  <td style={{ verticalAlign: 'middle', paddingRight: '10px' }}>
                    <Img
                      src={LOGO}
                      width="28"
                      height="28"
                      alt=""
                      style={{ borderRadius: '6px', display: 'block' }}
                    />
                  </td>
                  <td style={{ verticalAlign: 'middle' }}>
                    <Text
                      style={{
                        fontFamily: FONT_HEADING,
                        fontStyle: 'italic',
                        fontWeight: 800,
                        fontSize: '18px',
                        letterSpacing: '-0.02em',
                        color: SUNDAY.ink,
                        margin: 0,
                      }}
                    >
                      RNB VAULT
                    </Text>
                  </td>
                </tr>
              </tbody>
            </table>
          </Section>

          {/* Card */}
          <Section
            style={{
              backgroundColor: SUNDAY.card,
              borderRadius: '16px',
              padding: '36px 32px',
              border: `1px solid ${SUNDAY.border}`,
            }}
          >
            <Text
              style={{
                fontFamily: FONT_MONO,
                fontSize: '11px',
                letterSpacing: '0.18em',
                textTransform: 'uppercase' as const,
                color: SUNDAY.orange,
                margin: '0 0 14px',
              }}
            >
              {eyebrow}
            </Text>
            {children}
          </Section>

          {/* Footer */}
          <Section style={{ padding: '24px 8px 8px' }}>
            {footerNote ? (
              <Text
                style={{
                  fontFamily: FONT_BODY,
                  fontSize: '12px',
                  lineHeight: '18px',
                  color: SUNDAY.muted,
                  margin: '0 0 12px',
                }}
              >
                {footerNote}
              </Text>
            ) : null}
            <Hr style={{ borderColor: SUNDAY.border, margin: '0 0 14px' }} />
            <Text
              style={{
                fontFamily: FONT_MONO,
                fontSize: '10px',
                letterSpacing: '0.14em',
                textTransform: 'uppercase' as const,
                color: SUNDAY.muted,
                margin: 0,
              }}
            >
              RnB Vault — Oslo&apos;s R&amp;B Culture Hub ·{' '}
              <Link href={SITE} style={{ color: SUNDAY.orange, textDecoration: 'none' }}>
                rnbvault.no
              </Link>
            </Text>
          </Section>
        </Container>
      </Body>
    </Html>
  );
}

/** Shared CTA button — the single hero element of every transactional email. */
export function VaultButton({ href, children }: { href: string; children: React.ReactNode }) {
  return (
    <table role="presentation" cellPadding={0} cellSpacing={0} style={{ margin: '24px 0' }}>
      <tbody>
        <tr>
          <td
            style={{
              backgroundColor: SUNDAY.orange,
              borderRadius: '12px',
            }}
          >
            <Link
              href={href}
              style={{
                display: 'inline-block',
                padding: '14px 28px',
                fontFamily: FONT_HEADING,
                fontWeight: 600,
                fontSize: '15px',
                color: '#FFFFFF',
                textDecoration: 'none',
              }}
            >
              {children}
            </Link>
          </td>
        </tr>
      </tbody>
    </table>
  );
}

export const headingStyle = {
  fontFamily: FONT_HEADING,
  fontStyle: 'italic' as const,
  fontWeight: 800,
  fontSize: '26px',
  lineHeight: '32px',
  letterSpacing: '-0.02em',
  color: SUNDAY.ink,
  margin: '0 0 14px',
};

export const bodyStyle = {
  fontFamily: FONT_BODY,
  fontSize: '15px',
  lineHeight: '24px',
  color: SUNDAY.ink,
  margin: '0 0 8px',
};

export const mutedStyle = {
  fontFamily: FONT_BODY,
  fontSize: '13px',
  lineHeight: '20px',
  color: SUNDAY.muted,
  margin: '16px 0 0',
};
