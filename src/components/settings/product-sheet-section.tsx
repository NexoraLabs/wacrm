'use client';

// ============================================================
// ProductSheetSection — "Google Sheet export" block inside the
// product edit dialog (product-manager.tsx).
//
// Lets an admin connect this product to a Google Sheet. Once
// connected, every completed order for this product (a flow's
// `export_order` node, fired when a customer finishes giving their
// shipping details) appends a row automatically — there's no manual
// "sync" button here, unlike the CSV importer.
//
// Gated behind an active paid membership (Wompi billing) once
// `BILLING_ENFORCEMENT_ENABLED` is turned on — see
// `src/lib/billing/gate.ts`. Today that flag is unset, so
// `membershipActive` is always true and this renders unlocked for
// everyone.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { toast } from 'sonner';
import { Copy, Loader2, Lock, Sheet, Trash2 } from 'lucide-react';

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
  serverConfigured: boolean;
  serviceAccountEmail: string | null;
  membershipActive: boolean;
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
    serverConfigured: false,
    serviceAccountEmail: null,
    membershipActive: true,
  });
  const [spreadsheetInput, setSpreadsheetInput] = useState('');
  const [sheetName, setSheetName] = useState('Orders');
  const [saving, setSaving] = useState(false);
  const [disconnecting, setDisconnecting] = useState(false);

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
        serverConfigured: boolean;
        serviceAccountEmail: string | null;
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

  async function handleSave() {
    if (!spreadsheetInput.trim()) {
      toast.error('Paste a spreadsheet id or URL first');
      return;
    }
    setSaving(true);
    try {
      const res = await fetch(`/api/products/${productId}/google-sheet`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ spreadsheetId: spreadsheetInput, sheetName }),
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
      setSheetName('Orders');
      await load();
    } catch (err) {
      console.error('[ProductSheetSection] disconnect error:', err);
      toast.error('Could not reach the server');
    } finally {
      setDisconnecting(false);
    }
  }

  async function copyServiceAccountEmail() {
    if (!state.serviceAccountEmail) return;
    try {
      await navigator.clipboard.writeText(state.serviceAccountEmail);
      toast.success('Service account email copied');
    } catch {
      toast.error('Copy failed — select and copy manually');
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
          Connect a sheet and every completed order for this product (customer finishes
          giving their shipping details in a flow) gets appended as a row automatically —
          no manual sync needed.
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
      ) : !state.serverConfigured ? (
        <p className="text-[11px] text-muted-foreground">
          Not set up on this server yet — an admin needs to set{' '}
          <code className="rounded bg-muted px-1 py-0.5">GOOGLE_SERVICE_ACCOUNT_EMAIL</code> and{' '}
          <code className="rounded bg-muted px-1 py-0.5">GOOGLE_SERVICE_ACCOUNT_PRIVATE_KEY</code>{' '}
          (see <code>.env.local.example</code>).
        </p>
      ) : (
        <>
          <div>
            <p className="text-[11px] text-muted-foreground">
              1. Share your sheet (Editor access) with:
            </p>
            <div className="mt-1 flex gap-2">
              <Input
                readOnly
                value={state.serviceAccountEmail ?? ''}
                className="bg-muted font-mono text-xs"
              />
              <Button type="button" variant="outline" size="sm" onClick={copyServiceAccountEmail}>
                <Copy className="size-3.5" />
              </Button>
            </div>
          </div>

          <div className="grid gap-2 sm:grid-cols-[1fr_auto_auto] sm:items-end">
            <div className="space-y-1">
              <Label className="text-[11px] text-muted-foreground">2. Spreadsheet URL or id</Label>
              <Input
                value={spreadsheetInput}
                onChange={(e) => setSpreadsheetInput(e.target.value)}
                placeholder="https://docs.google.com/spreadsheets/d/..."
                className="text-xs"
              />
            </div>
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
              <Button type="button" size="sm" onClick={handleSave} disabled={saving}>
                {saving ? <Loader2 className="size-3.5 animate-spin" /> : <Sheet className="size-3.5" />}
                {state.config ? 'Update' : 'Connect'}
              </Button>
            </RequireRole>
          </div>

          {state.config && (
            <div className="flex items-center justify-between gap-2 pt-1">
              <p className="text-[11px] text-muted-foreground">
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
