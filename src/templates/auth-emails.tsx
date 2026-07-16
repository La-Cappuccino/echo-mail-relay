/** Auth emails — GoTrue `magiclink` + `signup` confirmation. */
import { Text } from '@react-email/components';
import * as React from 'react';
import {
  VaultEmailLayout,
  VaultButton,
  headingStyle,
  bodyStyle,
  mutedStyle,
} from './vault-layout.js';

export function MagicLinkEmail({ magicUrl }: { magicUrl: string }) {
  return (
    <VaultEmailLayout
      preview="Your RnB Vault sign-in link — valid for 1 hour."
      eyebrow="Magic link"
      footerNote="You received this because someone requested a sign-in link for your RnB Vault account. If this wasn't you, ignore this email."
    >
      <Text style={headingStyle}>Your key to the Vault.</Text>
      <Text style={bodyStyle}>
        Tap below to sign in — no password needed. The link works once and expires in
        1&nbsp;hour.
      </Text>
      <VaultButton href={magicUrl}>Sign in to RnB Vault</VaultButton>
      <Text style={mutedStyle}>
        Button not working? Copy this link into your browser: {magicUrl}
      </Text>
    </VaultEmailLayout>
  );
}

export function SignupConfirmEmail({ confirmUrl }: { confirmUrl: string }) {
  return (
    <VaultEmailLayout
      preview="Confirm your email to activate your RnB Vault account."
      eyebrow="Confirm your email"
      footerNote="You received this because this address was used to create an RnB Vault account. If this wasn't you, ignore this email and nothing happens."
    >
      <Text style={headingStyle}>Welcome to the Vault.</Text>
      <Text style={bodyStyle}>
        One tap to confirm your email and unlock quizzes, events and the Oslo R&amp;B
        community.
      </Text>
      <VaultButton href={confirmUrl}>Confirm email</VaultButton>
      <Text style={mutedStyle}>
        Button not working? Copy this link into your browser: {confirmUrl}
      </Text>
    </VaultEmailLayout>
  );
}
