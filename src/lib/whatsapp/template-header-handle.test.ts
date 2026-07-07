import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

// Stub the Meta resumable upload so the helper is tested in isolation.
vi.mock('./meta-api', () => ({
  uploadResumableMedia: vi.fn(async () => ({ handle: 'HANDLE123' })),
}));

import { ensureHeaderHandle } from './template-header-handle';
import { uploadResumableMedia } from './meta-api';
import type { TemplatePayload } from './template-validators';

function payload(over: Partial<TemplatePayload> = {}): TemplatePayload {
  return {
    name: 't',
    category: 'Utility',
    language: 'en_US',
    body_text: 'hi',
    header_type: 'image',
    header_media_url: 'https://x.test/img.jpg',
    ...over,
  };
}

function mediaResponse(type: string, size = 1024, ok = true, status = 200): Response {
  return {
    ok,
    status,
    headers: { get: (h: string) => (h.toLowerCase() === 'content-type' ? type : null) },
    arrayBuffer: async () => new ArrayBuffer(size),
  } as unknown as Response;
}

describe('ensureHeaderHandle', () => {
  beforeEach(() => {
    vi.mocked(uploadResumableMedia).mockClear();
  });
  afterEach(() => {
    vi.unstubAllGlobals();
    vi.unstubAllEnvs();
  });

  it('is a no-op for non-media headers', async () => {
    const p = payload({ header_type: 'text', header_content: 'Hi' });
    await ensureHeaderHandle(p, 'tok');
    expect(uploadResumableMedia).not.toHaveBeenCalled();
    expect(p.header_handle).toBeUndefined();
  });

  it('is a no-op when a handle already exists', async () => {
    const p = payload({ header_handle: 'existing' });
    await ensureHeaderHandle(p, 'tok');
    expect(uploadResumableMedia).not.toHaveBeenCalled();
    expect(p.header_handle).toBe('existing');
  });

  it('throws an actionable error when META_APP_ID is unset', async () => {
    const p = payload();
    await expect(ensureHeaderHandle(p, 'tok')).rejects.toThrow(/META_APP_ID/);
  });

  describe('image headers', () => {
    it('derives + sets header_handle from a valid image URL', async () => {
      vi.stubEnv('META_APP_ID', 'app-1');
      vi.stubGlobal('fetch', vi.fn(async () => mediaResponse('image/jpeg', 2048)));
      const p = payload();
      await ensureHeaderHandle(p, 'tok');
      expect(uploadResumableMedia).toHaveBeenCalledOnce();
      expect(p.header_handle).toBe('HANDLE123');
    });

    it('rejects a non-image content type', async () => {
      vi.stubEnv('META_APP_ID', 'app-1');
      vi.stubGlobal('fetch', vi.fn(async () => mediaResponse('text/html')));
      await expect(ensureHeaderHandle(payload(), 'tok')).rejects.toThrow(/JPEG or PNG/);
    });

    it('rejects an image over 5 MB', async () => {
      vi.stubEnv('META_APP_ID', 'app-1');
      vi.stubGlobal('fetch', vi.fn(async () => mediaResponse('image/png', 6 * 1024 * 1024)));
      await expect(ensureHeaderHandle(payload(), 'tok')).rejects.toThrow(/5 MB/);
    });
  });

  describe('video headers', () => {
    function videoPayload(over: Partial<TemplatePayload> = {}) {
      return payload({
        header_type: 'video',
        header_media_url: 'https://x.test/clip.mp4',
        ...over,
      });
    }

    it('derives + sets header_handle from a valid video URL', async () => {
      vi.stubEnv('META_APP_ID', 'app-1');
      vi.stubGlobal('fetch', vi.fn(async () => mediaResponse('video/mp4', 2048)));
      const p = videoPayload();
      await ensureHeaderHandle(p, 'tok');
      expect(uploadResumableMedia).toHaveBeenCalledOnce();
      expect(p.header_handle).toBe('HANDLE123');
    });

    it('rejects a non-video content type', async () => {
      vi.stubEnv('META_APP_ID', 'app-1');
      vi.stubGlobal('fetch', vi.fn(async () => mediaResponse('image/png')));
      await expect(ensureHeaderHandle(videoPayload(), 'tok')).rejects.toThrow(/MP4 or 3GPP/);
    });

    it('rejects a video over 16 MB', async () => {
      vi.stubEnv('META_APP_ID', 'app-1');
      vi.stubGlobal('fetch', vi.fn(async () => mediaResponse('video/mp4', 17 * 1024 * 1024)));
      await expect(ensureHeaderHandle(videoPayload(), 'tok')).rejects.toThrow(/16 MB/);
    });
  });

  describe('document headers', () => {
    function documentPayload(over: Partial<TemplatePayload> = {}) {
      return payload({
        header_type: 'document',
        header_media_url: 'https://x.test/spec.pdf',
        ...over,
      });
    }

    it('derives + sets header_handle from a valid PDF URL', async () => {
      vi.stubEnv('META_APP_ID', 'app-1');
      vi.stubGlobal('fetch', vi.fn(async () => mediaResponse('application/pdf', 2048)));
      const p = documentPayload();
      await ensureHeaderHandle(p, 'tok');
      expect(uploadResumableMedia).toHaveBeenCalledOnce();
      expect(p.header_handle).toBe('HANDLE123');
    });

    it('rejects a non-PDF content type', async () => {
      vi.stubEnv('META_APP_ID', 'app-1');
      vi.stubGlobal('fetch', vi.fn(async () => mediaResponse('application/msword')));
      await expect(ensureHeaderHandle(documentPayload(), 'tok')).rejects.toThrow(/PDF/);
    });

    it('rejects a document over 100 MB', async () => {
      vi.stubEnv('META_APP_ID', 'app-1');
      vi.stubGlobal(
        'fetch',
        vi.fn(async () => mediaResponse('application/pdf', 101 * 1024 * 1024)),
      );
      await expect(ensureHeaderHandle(documentPayload(), 'tok')).rejects.toThrow(/100 MB/);
    });
  });
});
