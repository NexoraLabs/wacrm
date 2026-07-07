/**
 * Translate our local template row shape into the `components` array
 * shape that Meta's POST /{waba_id}/message_templates endpoint expects.
 *
 * Keep this function pure and JSON-shaped — the submit route and the
 * (future) edit route both call it, and unit tests assert the exact
 * payload by snapshot.
 *
 * Spec reference:
 *   https://developers.facebook.com/docs/whatsapp/business-management-api/message-templates/components
 */

import type { TemplatePayload } from './template-validators';
import type { TemplateButton } from '@/types';

export interface MetaComponent {
  type: 'HEADER' | 'BODY' | 'FOOTER' | 'BUTTONS';
  format?: 'TEXT' | 'IMAGE' | 'VIDEO' | 'DOCUMENT';
  text?: string;
  buttons?: MetaButtonPayload[];
  add_security_recommendation?: boolean;
  code_expiration_minutes?: number;
  example?: {
    header_text?: string[];
    header_url?: string[];
    header_handle?: string[];
    body_text?: string[][];
  };
}

interface MetaButtonPayload {
  type: 'QUICK_REPLY' | 'URL' | 'PHONE_NUMBER' | 'COPY_CODE' | 'OTP';
  text?: string;
  url?: string;
  phone_number?: string;
  example?: string[];
  otp_type?: 'COPY_CODE' | 'ONE_TAP' | 'ZERO_TAP';
  package_name?: string;
  signature_hash?: string;
}

function buildHeaderComponent(payload: TemplatePayload): MetaComponent | null {
  const { header_type, header_content, header_media_url, header_handle } = payload;
  if (!header_type) return null;

  if (header_type === 'text') {
    const headerSample = payload.sample_values?.header;
    const component: MetaComponent = {
      type: 'HEADER',
      format: 'TEXT',
      text: header_content,
    };
    if (headerSample && headerSample.length > 0) {
      component.example = { header_text: headerSample };
    }
    return component;
  }

  const format =
    header_type === 'image'
      ? 'IMAGE'
      : header_type === 'video'
        ? 'VIDEO'
        : 'DOCUMENT';
  const component: MetaComponent = { type: 'HEADER', format };
  if (header_handle) {
    component.example = { header_handle: [header_handle] };
  } else if (header_media_url) {
    component.example = { header_url: [header_media_url] };
  }
  return component;
}

function buildBodyComponent(payload: TemplatePayload): MetaComponent {
  const component: MetaComponent = {
    type: 'BODY',
    text: payload.body_text,
  };
  const bodySample = payload.sample_values?.body;
  if (bodySample && bodySample.length > 0) {
    // Meta expects body_text as a 2D array — outer is "examples",
    // inner is the values for each variable. We submit a single
    // example row.
    component.example = { body_text: [bodySample] };
  }
  return component;
}

function buildFooterComponent(payload: TemplatePayload): MetaComponent | null {
  if (!payload.footer_text?.trim()) return null;
  return { type: 'FOOTER', text: payload.footer_text };
}

function buildButtonPayload(b: TemplateButton): MetaButtonPayload {
  switch (b.type) {
    case 'QUICK_REPLY':
      return { type: 'QUICK_REPLY', text: b.text };
    case 'URL': {
      const payload: MetaButtonPayload = {
        type: 'URL',
        text: b.text,
        url: b.url,
      };
      if (b.example) payload.example = [b.example];
      return payload;
    }
    case 'PHONE_NUMBER':
      return { type: 'PHONE_NUMBER', text: b.text, phone_number: b.phone_number };
    case 'COPY_CODE':
      return { type: 'COPY_CODE', text: b.text, example: [b.example] };
    case 'OTP': {
      const payload: MetaButtonPayload = { type: 'OTP', otp_type: b.otp_type };
      if (b.package_name) payload.package_name = b.package_name;
      if (b.signature_hash) payload.signature_hash = b.signature_hash;
      return payload;
    }
  }
}

function buildButtonsComponent(payload: TemplatePayload): MetaComponent | null {
  if (!payload.buttons || payload.buttons.length === 0) return null;
  return {
    type: 'BUTTONS',
    buttons: payload.buttons.map(buildButtonPayload),
  };
}

export interface MetaTemplateSubmitPayload {
  name: string;
  category: 'MARKETING' | 'UTILITY' | 'AUTHENTICATION';
  language: string;
  components: MetaComponent[];
}

const CATEGORY_TO_META: Record<
  'Marketing' | 'Utility' | 'Authentication',
  MetaTemplateSubmitPayload['category']
> = {
  Marketing: 'MARKETING',
  Utility: 'UTILITY',
  Authentication: 'AUTHENTICATION',
};

/**
 * AUTHENTICATION components: no HEADER, a flag-only BODY (Meta
 * generates the actual localized text), an optional flag-only FOOTER,
 * and exactly one OTP button. `validateAuthenticationPayload` already
 * guarantees the OTP button exists by the time this runs.
 */
function buildAuthenticationComponents(payload: TemplatePayload): MetaComponent[] {
  const components: MetaComponent[] = [
    { type: 'BODY', add_security_recommendation: Boolean(payload.add_security_recommendation) },
  ];
  if (payload.code_expiration_minutes) {
    components.push({ type: 'FOOTER', code_expiration_minutes: payload.code_expiration_minutes });
  }
  const otp = payload.buttons?.find((b) => b.type === 'OTP');
  if (otp) {
    components.push({ type: 'BUTTONS', buttons: [buildButtonPayload(otp)] });
  }
  return components;
}

/**
 * Assemble the full submit payload (name + category + language +
 * components in canonical order: HEADER → BODY → FOOTER → BUTTONS).
 */
export function buildMetaTemplatePayload(
  payload: TemplatePayload,
): MetaTemplateSubmitPayload {
  const components =
    payload.category === 'Authentication'
      ? buildAuthenticationComponents(payload)
      : (() => {
          const list: MetaComponent[] = [];
          const header = buildHeaderComponent(payload);
          if (header) list.push(header);
          list.push(buildBodyComponent(payload));
          const footer = buildFooterComponent(payload);
          if (footer) list.push(footer);
          const buttons = buildButtonsComponent(payload);
          if (buttons) list.push(buttons);
          return list;
        })();

  return {
    name: payload.name,
    category: CATEGORY_TO_META[payload.category],
    language: payload.language,
    components,
  };
}
