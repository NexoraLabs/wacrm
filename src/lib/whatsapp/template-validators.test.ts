import { describe, expect, it } from 'vitest';
import {
  extractVariableIndices,
  TEMPLATE_LIMITS,
  validateAuthenticationPayload,
  validateBody,
  validateButtons,
  validateFooter,
  validateHeader,
  validateSampleValues,
  validateTemplateName,
  validateTemplatePayload,
  type TemplatePayload,
} from './template-validators';

const baseValid: TemplatePayload = {
  name: 'order_confirmation',
  category: 'Utility',
  language: 'en_US',
  body_text: 'Your order is confirmed.',
};

describe('extractVariableIndices', () => {
  it('returns sorted unique 1-based indices', () => {
    expect(extractVariableIndices('Hi {{2}} and {{1}} {{2}}')).toEqual([1, 2]);
  });
  it('returns empty array for no variables', () => {
    expect(extractVariableIndices('No vars here')).toEqual([]);
  });
});

describe('validateTemplateName', () => {
  it('accepts lowercase + digits + underscore', () => {
    expect(() => validateTemplateName('order_v2')).not.toThrow();
  });
  it('rejects uppercase', () => {
    expect(() => validateTemplateName('OrderV2')).toThrow(/lowercase/);
  });
  it('rejects empty', () => {
    expect(() => validateTemplateName('')).toThrow(/required/);
  });
  it('rejects spaces and dashes', () => {
    expect(() => validateTemplateName('order v2')).toThrow();
    expect(() => validateTemplateName('order-v2')).toThrow();
  });
});

describe('validateBody', () => {
  it('rejects empty', () => {
    expect(() => validateBody('   ')).toThrow(/required/);
  });
  it('rejects > 1024 chars', () => {
    expect(() => validateBody('x'.repeat(TEMPLATE_LIMITS.bodyMaxLength + 1))).toThrow(
      /exceeds 1024/,
    );
  });
  it('rejects non-contiguous variables', () => {
    expect(() => validateBody('Hi {{1}} {{3}}')).toThrow(/contiguous/);
  });
  it('accepts contiguous variables', () => {
    expect(validateBody('Hi {{1}} {{2}}')).toEqual([1, 2]);
  });
});

describe('validateFooter', () => {
  it('accepts undefined', () => {
    expect(() => validateFooter(undefined)).not.toThrow();
  });
  it('rejects > 60 chars', () => {
    expect(() => validateFooter('x'.repeat(61))).toThrow(/60 chars/);
  });
  it('rejects variables in footer', () => {
    expect(() => validateFooter('Powered by {{1}}')).toThrow(/cannot contain/);
  });
});

describe('validateHeader', () => {
  it('text header requires content', () => {
    expect(() =>
      validateHeader({ header_type: 'text', header_content: '' }),
    ).toThrow(/requires header_content/);
  });
  it('text header rejects > 60 chars', () => {
    expect(() =>
      validateHeader({ header_type: 'text', header_content: 'x'.repeat(61) }),
    ).toThrow(/60 chars/);
  });
  it('text header rejects more than one variable', () => {
    expect(() =>
      validateHeader({ header_type: 'text', header_content: '{{1}} {{2}}' }),
    ).toThrow(/at most one variable/);
  });
  it('text header requires variable to be {{1}}', () => {
    expect(() =>
      validateHeader({ header_type: 'text', header_content: 'Hello {{2}}' }),
    ).toThrow(/must be \{\{1\}\}/);
  });
  it('image header requires a URL or handle', () => {
    expect(() => validateHeader({ header_type: 'image' })).toThrow(
      /requires either/,
    );
  });
  it('image header accepts a URL', () => {
    expect(() =>
      validateHeader({
        header_type: 'image',
        header_media_url: 'https://example.com/img.jpg',
      }),
    ).not.toThrow();
  });
  it('image header rejects a non-URL string', () => {
    expect(() =>
      validateHeader({
        header_type: 'image',
        header_media_url: 'not a url',
      }),
    ).toThrow(/valid URL/);
  });
});

describe('validateButtons', () => {
  it('accepts undefined / empty', () => {
    expect(() => validateButtons(undefined)).not.toThrow();
    expect(() => validateButtons([])).not.toThrow();
  });
  it('rejects an OTP button (AUTHENTICATION-only)', () => {
    expect(() =>
      validateButtons([{ type: 'OTP', otp_type: 'COPY_CODE' }]),
    ).toThrow(/AUTHENTICATION/);
  });
  it('rejects > 10 buttons', () => {
    const tooMany = Array.from({ length: 11 }, () => ({
      type: 'QUICK_REPLY' as const,
      text: 'Hi',
    }));
    expect(() => validateButtons(tooMany)).toThrow(/at most 10 buttons/);
  });
  it('rejects > 2 URL buttons', () => {
    expect(() =>
      validateButtons([
        { type: 'URL', text: 'a', url: 'https://x' },
        { type: 'URL', text: 'b', url: 'https://x' },
        { type: 'URL', text: 'c', url: 'https://x' },
      ]),
    ).toThrow(/At most 2 URL/);
  });
  it('rejects > 1 PHONE_NUMBER', () => {
    expect(() =>
      validateButtons([
        { type: 'PHONE_NUMBER', text: 'a', phone_number: '+1' },
        { type: 'PHONE_NUMBER', text: 'b', phone_number: '+2' },
      ]),
    ).toThrow(/At most 1 PHONE_NUMBER/);
  });
  it('rejects > 1 COPY_CODE', () => {
    expect(() =>
      validateButtons([
        { type: 'COPY_CODE', text: 'a', example: 'X' },
        { type: 'COPY_CODE', text: 'b', example: 'Y' },
      ]),
    ).toThrow(/At most 1 COPY_CODE/);
  });
  it('rejects QUICK_REPLY interleaved with CTA buttons', () => {
    expect(() =>
      validateButtons([
        { type: 'QUICK_REPLY', text: 'A' },
        { type: 'URL', text: 'B', url: 'https://x' },
        { type: 'QUICK_REPLY', text: 'C' },
      ]),
    ).toThrow(/cannot be interleaved/);
  });
  it('accepts QUICK_REPLY then CTA in correct order', () => {
    expect(() =>
      validateButtons([
        { type: 'QUICK_REPLY', text: 'A' },
        { type: 'QUICK_REPLY', text: 'B' },
        { type: 'URL', text: 'C', url: 'https://x' },
      ]),
    ).not.toThrow();
  });
  it('rejects empty button text', () => {
    expect(() =>
      validateButtons([{ type: 'QUICK_REPLY', text: '' }]),
    ).toThrow(/missing text/);
  });
  it('rejects URL button without url', () => {
    expect(() =>
      validateButtons([{ type: 'URL', text: 'Go', url: '' }]),
    ).toThrow(/missing url/);
  });
  it('rejects URL button with invalid url', () => {
    expect(() =>
      validateButtons([{ type: 'URL', text: 'Go', url: 'not-a-url' }]),
    ).toThrow(/invalid url/);
  });
  it('rejects URL with {{1}} but no example', () => {
    expect(() =>
      validateButtons([
        { type: 'URL', text: 'Go', url: 'https://x/{{1}}' },
      ]),
    ).toThrow(/Meta requires an example/);
  });
  it('rejects URL with non-{{1}} variable', () => {
    expect(() =>
      validateButtons([
        {
          type: 'URL',
          text: 'Go',
          url: 'https://x/{{2}}',
          example: 'foo',
        },
      ]),
    ).toThrow(/must be \{\{1\}\}/);
  });
  it('rejects PHONE_NUMBER without phone_number', () => {
    expect(() =>
      validateButtons([
        { type: 'PHONE_NUMBER', text: 'Call', phone_number: '' },
      ]),
    ).toThrow(/missing phone_number/);
  });
  it('rejects COPY_CODE without example', () => {
    expect(() =>
      validateButtons([{ type: 'COPY_CODE', text: 'Copy', example: '' }]),
    ).toThrow(/missing example/);
  });
});

describe('validateSampleValues', () => {
  it('rejects mismatched body sample count', () => {
    expect(() =>
      validateSampleValues(
        { ...baseValid, body_text: 'Hi {{1}}', sample_values: { body: [] } },
        1,
        0,
      ),
    ).toThrow(/exactly 1 sample/);
  });
  it('rejects empty sample values', () => {
    expect(() =>
      validateSampleValues(
        { ...baseValid, sample_values: { body: ['  '] } },
        1,
        0,
      ),
    ).toThrow(/empty/);
  });
  it('accepts matching counts', () => {
    expect(() =>
      validateSampleValues(
        { ...baseValid, sample_values: { body: ['John'] } },
        1,
        0,
      ),
    ).not.toThrow();
  });
});

describe('validateTemplatePayload — integration', () => {
  it('passes for a minimal valid payload', () => {
    expect(validateTemplatePayload(baseValid)).toEqual({
      bodyVarCount: 0,
      headerVarCount: 0,
    });
  });
  it('passes with body variables + matching samples', () => {
    expect(
      validateTemplatePayload({
        ...baseValid,
        body_text: 'Hi {{1}}, order {{2}} confirmed.',
        sample_values: { body: ['John', 'ORD-42'] },
      }),
    ).toEqual({ bodyVarCount: 2, headerVarCount: 0 });
  });
  it('throws on missing samples for body variables', () => {
    expect(() =>
      validateTemplatePayload({
        ...baseValid,
        body_text: 'Hi {{1}}',
      }),
    ).toThrow(/exactly 1 sample/);
  });
});

const baseAuth: TemplatePayload = {
  name: 'otp_login',
  category: 'Authentication',
  language: 'en_US',
  body_text: 'placeholder — Meta generates the real text',
  buttons: [{ type: 'OTP', otp_type: 'COPY_CODE' }],
};

describe('validateAuthenticationPayload', () => {
  it('passes with a single COPY_CODE OTP button', () => {
    expect(() => validateAuthenticationPayload(baseAuth)).not.toThrow();
  });

  it('throws when no OTP button is present', () => {
    expect(() =>
      validateAuthenticationPayload({ ...baseAuth, buttons: [] }),
    ).toThrow(/exactly one OTP button/);
  });

  it('throws when a non-OTP button is mixed in', () => {
    expect(() =>
      validateAuthenticationPayload({
        ...baseAuth,
        buttons: [{ type: 'OTP', otp_type: 'COPY_CODE' }, { type: 'QUICK_REPLY', text: 'Hi' }],
      }),
    ).toThrow(/exactly one OTP button/);
  });

  it('requires package_name + signature_hash for ONE_TAP', () => {
    expect(() =>
      validateAuthenticationPayload({
        ...baseAuth,
        buttons: [{ type: 'OTP', otp_type: 'ONE_TAP' }],
      }),
    ).toThrow(/package_name/);
    expect(() =>
      validateAuthenticationPayload({
        ...baseAuth,
        buttons: [
          { type: 'OTP', otp_type: 'ONE_TAP', package_name: 'com.example.app' },
        ],
      }),
    ).toThrow(/signature_hash/);
  });

  it('passes for ONE_TAP with both Android fields set', () => {
    expect(() =>
      validateAuthenticationPayload({
        ...baseAuth,
        buttons: [
          {
            type: 'OTP',
            otp_type: 'ONE_TAP',
            package_name: 'com.example.app',
            signature_hash: 'abc123',
          },
        ],
      }),
    ).not.toThrow();
  });

  it('rejects code_expiration_minutes outside 1-90', () => {
    expect(() =>
      validateAuthenticationPayload({ ...baseAuth, code_expiration_minutes: 0 }),
    ).toThrow(/between 1 and 90/);
    expect(() =>
      validateAuthenticationPayload({ ...baseAuth, code_expiration_minutes: 91 }),
    ).toThrow(/between 1 and 90/);
    expect(() =>
      validateAuthenticationPayload({ ...baseAuth, code_expiration_minutes: 10 }),
    ).not.toThrow();
  });
});

describe('validateTemplatePayload — AUTHENTICATION branch', () => {
  it('routes to validateAuthenticationPayload and skips body/header/footer rules', () => {
    expect(validateTemplatePayload(baseAuth)).toEqual({
      bodyVarCount: 0,
      headerVarCount: 0,
    });
  });

  it('still enforces name + language for AUTHENTICATION', () => {
    expect(() =>
      validateTemplatePayload({ ...baseAuth, name: '' }),
    ).toThrow(/name is required/i);
  });

  it('still throws AUTHENTICATION-specific errors through the main entry point', () => {
    expect(() =>
      validateTemplatePayload({ ...baseAuth, buttons: [] }),
    ).toThrow(/exactly one OTP button/);
  });
});
