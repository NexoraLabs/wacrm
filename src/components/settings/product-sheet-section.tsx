'use client';

// ============================================================
// ProductSheetSection — "Google Sheet export" block inside the
// product edit dialog (product-manager.tsx).
//
// Lets an admin pick this product's destination Google Sheet via
// Google's file picker (Settings → Google must be connected first —
// see google-connection-settings.tsx). Once picked, every completed
// order for this product (a flow's `export_order` node, fired when a
// customer finishes giving their shipping details) appends a row
// automatically — no manual "sync" button here, unlike the CSV
// importer.
//
// Gated behind an active paid membership (Wompi billing) once
// `BILLING_ENFORCEMENT_ENABLED` is turned on — see
// `src/lib/billing/gate.ts`. Today that flag is unset, so
// `membershipActive` is always true and this renders unlocked for
// everyone.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { FileSpreadsheet, Link2, Loader2, Lock, Trash2 } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { RequireRole } from '@/components/auth/require-role';

interface SheetConfig {
  id: string;
  spreadsheet_id: string;
  sheet_name: string;
  last_exported_at: string | null;
}

interface LoadState {
  loading: boolean;
  config: SheetConfig | null;
  googleConnected: boolean;
  membershipActive: boolean;
}

// Minimal shape of the bits of the Picker API this file touches —
// avoids pulling in @types/google.picker for a handful of calls.
interface GooglePickerBuilder {
  addView(view: unknown): GooglePickerBuilder;
  setOAuthToken(token: string): GooglePickerBuilder;
  setDeveloperKey(key: string): GooglePickerBuilder;
  setCallback(
    cb: (data: { action: string; docs?: { id: string; name: string }[] }) => void
  ): GooglePickerBuilder;
  build(): { setVisible(visible: boolean): void };
}

interface GooglePickerApi {
  ViewId: { SPREADSHEETS: string };
  Action: { PICKED: string };
  DocsView: new (viewId: string) => unknown;
  PickerBuilder: new () => GooglePickerBuilder;
}

declare global {
  interface Window {
    gapi?: {
      load: (
        module: string,
        options: { callback: () => void; onerror: () => void }
      ) => void;
    };
    google?: {
      picker: GooglePickerApi;
    };
  }
}

let gapiLoadPromise: Promise<void> | null = null;

function loadPicker(): Promise<void> {
  if (typeof window === 'undefined') return Promise.reject(new Error('No window'));
  if (window.google?.picker) return Promise.resolve();
  if (gapiLoadPromise) return gapiLoadPromise;
  gapiLoadPromise = new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = 'https://apis.google.com/js/api.js';
    script.onload = () => {
      window.gapi?.load('picker', { callback: resolve, onerror: () => reject(new Error('picker load failed')) });
    };
    script.onerror = () => reject(new Error('Failed to load the Google API script'));
    document.body.appendChild(script);
  });
  return gapiLoadPromise;
}

function fmtDateTime(iso: string): string {
  return new Date(iso).toLocaleString(undefined, {
    year: 'numeric',
    month: 'short',
    day: 'numeric',
    hour: 'numeric',
    minute: '2-digit',
  });
}

export function ProductSheetSection({ productId }: { productId: string }) {
  const [state, setState] = useState<LoadState>({
    loading: true,
    config: null,
    googleConnected: false,
    membershipActive: true,
  });
  const [spreadsheetInput, setSpreadsheetInput] = useState('');
  const [spreadsheetName, setSpreadsheetName] = useState<string | null>(null);
  const [sheetName, setSheetName] = useState('Orders');
  const [saving, setSaving] = useState(false);
  const [pickerLoading, setPickerLoading] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);
  const [showManualInput, setShowManualInput] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch(`/api/products/${productId}/google-sheet`, { cache: 'no-store' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Failed to load Google Sheet configuration');
        return;
      }
      const data = (await res.json()) as {
        config: SheetConfig | null;
        googleConnected: boolean;
        membershipActive: boolean;
      };
      setState({ loading: false, ...data });
      if (data.config) {
        setSpreadsheetInput(data.config.spreadsheet_id);
        setSheetName(data.config.sheet_name);
      }
    } catch (err) {
      console.error('[ProductSheetSection] load error:', err);
      toast.error('Could not reach the server');
      setState((prev) => ({ ...prev, loading: false }));
    }
  }, [productId]);

  useEffect(() => {
    void load();
  }, [load]);

  async function saveSpreadsheetId(id: string) {
    if (!id.trim()) {
      toast.error('Pick a sheet or paste a spreadsheet id/URL first');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/products/${productId}/google-sheet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spreadsheetId: id, sheetName }),
      });
      const payload = await res.json().catch(() => ({}));
      if (!res.ok) {
        toast.error(payload.error || 'Failed to save configuration');
        return;
      }
      toast.success('Google Sheet connected');
      await load();
    } catch (err) {
      console.error('[ProductSheetSection] save error:', err);
      toast.error('Could not reach the server');
    } finally {
      setSaving(false);
    }
  }

  async function handleOpenPicker() {
    setPickerLoading(true);
    try {
      const tokenRes = await fetch('/api/integrations/google/picker-token');
      const tokenPayload = await tokenRes.json().catch(() => ({}));
      if (!tokenRes.ok) {
        toast.error(tokenPayload.error || 'Failed to get a Google access token');
        return;
      }

      await loadPicker();
      const apiKey = process.env.NEXT_PUBLIC_GOOGLE_PICKER_API_KEY;
      if (!apiKey) {
        toast.error('NEXT_PUBLIC_GOOGLE_PICKER_API_KEY is not configured on this deployment.');
        return;
      }
      if (!window.google?.picker) {
        toast.error('Google file picker failed to load.');
        return;
      }

      const view = new window.google.picker.DocsView(window.google.picker.ViewId.SPREADSHEETS);
      const picker = new window.google.picker.PickerBuilder()
        .addView(view)
        .setOAuthToken(tokenPayload.accessToken as string)
        .setDeveloperKey(apiKey)
        .setCallback((data) => {
          if (data.action === window.google!.picker.Action.PICKED && data.docs?.[0]) {
            const doc = data.docs[0];
            setSpreadsheetInput(doc.id);
            setSpreadsheetName(doc.name);
            void saveSpreadsheetId(doc.id);
          }
        })
        .build();
      picker.setVisible(true);
    } catch (err) {
      console.error('[ProductSheetSection] picker error:', err);
      toast.error('Could not open the Google file picker');
    } finally {
      setPickerLoading(false);
    }
  }

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      const res = await fetch(`/api/products/${productId}/google-sheet`, { method: 'DELETE' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Failed to disconnect');
        return;
      }
      toast.success('Google Sheet disconnected');
      setSpreadsheetInput('');
      setSpreadsheetName(null);
      setSheetName('Orders');
      await load();
    } catch (err) {
      console.error('[ProductSheetSection] disconnect error:', err);
      toast.error('Could not reach the server');
    } finally {
      setDisconnecting(false);
    }
  }

  if (state.loading) {
    return (
      <div className="flex items-center justify-center rounded-md border border-border py-6">
        <Loader2 className="text-primary size-5 animate-spin" />
      </div>
    );
  }

  return (
    <div className="space-y-3 rounded-md border border-border p-3">
      <div>
        <Label className="text-muted-foreground">Google Sheet export</Label>
        <p className="mt-1 text-[11px] text-muted-foreground">
          Pick a sheet and every completed order for this product (customer finishes giving
          their shipping details in a flow) gets appended as a row automatically — no manual
          sync needed.
        </p>
      </div>

      {!state.membershipActive ? (
        <div className="flex items-start gap-2 rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
          <Lock className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Available on paid plans. Head to{' '}
            <a href="/settings?tab=billing" className="text-primary underline">
              Settings → Billing
            </a>{' '}
            to upgrade.
          </span>
        </div>
      ) : !state.googleConnected ? (
        <div className="flex items-start gap-2 rounded-md bg-muted/60 p-3 text-xs text-muted-foreground">
          <Link2 className="mt-0.5 size-3.5 shrink-0" />
          <span>
            Connect your Google account first in{' '}
            <a href="/settings?tab=google" className="text-primary underline">
              Settings → Google
            </a>
            .
          </span>
        </div>
      ) : (
        <>
          <div className="grid gap-2 sm:grid-cols-[auto_auto] sm:items-end">
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">Tab name</Label>
              <Input
                value={sheetName}
                onChange={(e) => setSheetName(e.target.value)}
                placeholder="Orders"
                className="w-28 text-xs"
              />
            </div>
            <RequireRole min="admin">
              <Button type="button" size="sm" onClick={handleOpenPicker} disabled={pickerLoading || saving}>
                {pickerLoading || saving ? (
                  <Loader2 className="size-3.5 animate-spin" />
                ) : (
                  <FileSpreadsheet className="size-3.5" />
                )}
                {state.config ? 'Cambiar hoja' : 'Elegir hoja de Google Sheets'}
              </Button>
            </RequireRole>
          </div>

          <RequireRole min="admin">
            {!showManualInput ? (
              <button
                type="button"
                onClick={() => setShowManualInput(true)}
                className="text-[11px] text-muted-foreground underline"
              >
                ¿El selector no abre? Pega la URL manualmente
              </button>
            ) : (
              <div className="flex gap-2">
                <Input
                  value={spreadsheetInput}
                  onChange={(e) => setSpreadsheetInput(e.target.value)}
                  placeholder="https://docs.google.com/spreadsheets/d/..."
                  className="text-xs"
                />
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  onClick={() => void saveSpreadsheetId(spreadsheetInput)}
                  disabled={saving}
                >
                  {saving ? <Loader2 className="size-3.5 animate-spin" /> : 'Guardar'}
                </Button>
              </div>
            )}
          </RequireRole>

          {state.config && (
            <div className="flex items-center justify-between gap-2 pt-1">
              <p className="text-[11px] text-muted-foreground">
                {spreadsheetName ?? state.config.spreadsheet_id} ·{' '}
                {state.config.last_exported_at
                  ? `Last export ${fmtDateTime(state.config.last_exported_at)}`
                  : 'Connected — no orders exported yet'}
              </p>
              <RequireRole min="admin">
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  onClick={handleDisconnect}
                  disabled={disconnecting}
                  className="border-red-500/40 bg-red-500/10 text-red-300 hover:border-red-500/60 hover:bg-red-500/20 hover:text-red-200"
                >
                  {disconnecting ? (
                    <Loader2 className="size-3.5 animate-spin" />
                  ) : (
                    <Trash2 className="size-3.5" />
                  )}
                  Disconnect
                </Button>
              </RequireRole>
            </div>
          )}
        </>
      )}
    </div>
  );
}
