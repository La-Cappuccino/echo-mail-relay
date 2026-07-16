/**
 * Template registry — relay-side rendering (SPEC assumption 4).
 * Keys are namespaced `<project-id>/<template>`; /send verifies the caller
 * owns the namespace. render() returns {subject, html, text}.
 */
import { render } from '@react-email/render';
import * as React from 'react';
import { PasswordResetEmail } from './password-reset.js';
import { MagicLinkEmail, SignupConfirmEmail } from './auth-emails.js';
import {
  NewsletterWelcomeEmail,
  EventApprovedEmail,
  EventRejectedEmail,
  AdminNotificationEmail,
} from './rnb-vault-emails.js';

type Rendered = { subject: string; html: string; text: string };

/* eslint-disable @typescript-eslint/no-explicit-any */
type TemplateDef = {
  subject: (data: any) => string;
  component: (data: any) => React.ReactElement;
  requires: string[];
};

const REGISTRY: Record<string, TemplateDef> = {
  'rnb-vault/password-reset': {
    subject: () => 'Reset your RnB Vault password',
    component: (d) => React.createElement(PasswordResetEmail, { resetUrl: d.resetUrl }),
    requires: ['resetUrl'],
  },
  'rnb-vault/magic-link': {
    subject: () => 'Your RnB Vault sign-in link',
    component: (d) => React.createElement(MagicLinkEmail, { magicUrl: d.magicUrl }),
    requires: ['magicUrl'],
  },
  'rnb-vault/signup-confirm': {
    subject: () => 'Confirm your RnB Vault account',
    component: (d) => React.createElement(SignupConfirmEmail, { confirmUrl: d.confirmUrl }),
    requires: ['confirmUrl'],
  },
  'rnb-vault/newsletter-welcome': {
    subject: () => "You're in — RnB Vault newsletter",
    component: (d) =>
      React.createElement(NewsletterWelcomeEmail, { unsubscribeUrl: d.unsubscribeUrl }),
    requires: ['unsubscribeUrl'],
  },
  'rnb-vault/event-approved': {
    subject: (d) => `"${d.event.eventTitle}" is live on RnB Vault`,
    component: (d) => React.createElement(EventApprovedEmail, { event: d.event, eventUrl: d.eventUrl }),
    requires: ['event', 'eventUrl'],
  },
  'rnb-vault/event-rejected': {
    subject: () => 'Update on your RnB Vault event submission',
    component: (d) =>
      React.createElement(EventRejectedEmail, {
        event: d.event,
        reason: d.reason,
        submitUrl: d.submitUrl,
      }),
    requires: ['event', 'submitUrl'],
  },
  'rnb-vault/admin-notification': {
    subject: (d) => `New event submission: ${d.event.eventTitle}`,
    component: (d) =>
      React.createElement(AdminNotificationEmail, {
        event: d.event,
        submitter: d.submitter,
        reviewUrl: d.reviewUrl,
      }),
    requires: ['event', 'submitter', 'reviewUrl'],
  },
};

export function listTemplates(): string[] {
  return Object.keys(REGISTRY);
}

export async function renderTemplate(
  name: string,
  data: Record<string, unknown>,
): Promise<Rendered> {
  const def = REGISTRY[name];
  if (!def) throw new TemplateError(`unknown template '${name}'`);
  for (const field of def.requires) {
    if (data?.[field] === undefined) throw new TemplateError(`template '${name}' requires data.${field}`);
  }
  const element = def.component(data);
  const html = await render(element);
  const text = await render(element, { plainText: true });
  return { subject: def.subject(data), html, text };
}

export class TemplateError extends Error {}
