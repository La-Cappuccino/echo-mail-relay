/** Password reset — the hero transactional email (GoTrue `recovery`). */
import { Text } from '@react-email/components';
import * as React from 'react';
import {
  VaultEmailLayout,
  VaultButton,
  headingStyle,
  bodyStyle,
  mutedStyle,
} from './vault-layout.js';

export function PasswordResetEmail({ resetUrl }: { resetUrl: string }) {
  return (
    <VaultEmailLayout
      preview="Reset your RnB Vault password — this link is valid for 1 hour."
      eyebrow="Password reset"
      footerNote="You received this because a password reset was requested for your RnB Vault account. If this wasn't you, you can safely ignore it — your password stays unchanged."
    >
      <Text style={headingStyle}>Back into the Vault.</Text>
      <Text style={bodyStyle}>
        Tap the button below to set a new password. The link works once and expires in
        1&nbsp;hour.
      </Text>
      <VaultButton href={resetUrl}>Set new password</VaultButton>
      <Text style={mutedStyle}>
        Button not working? Copy this link into your browser: {resetUrl}
      </Text>
    </VaultEmailLayout>
  );
}
