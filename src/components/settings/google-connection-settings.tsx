'use client';

// ============================================================
// GoogleConnectionSettings — Settings → Google
//
// Account-wide "Connect with Google" — connect once, then every
// product's "Google Sheet export" section (product-sheet-section.tsx)
// can pick a destination sheet via Google's file picker, no per-
// product re-authorization and no sharing a spreadsheet with a
// service-account email.
// ============================================================

import { useCallback, useEffect, useState } from 'react';
import { useSearchParams } from 'next/navigation';
import { toast } from 'sonner';
import { CheckCircle2, Loader2, Unlink } from 'lucide-react';

import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { RequireRole } from '@/components/auth/require-role';
import { SettingsPanelHead } from './settings-panel-head';

interface ConnectionState {
  loading: boolean;
  connected: boolean;
  email: string | null;
  serverConfigured: boolean;
}

const ERROR_MESSAGES: Record<string, string> = {
  access_denied: 'You canceled the Google authorization.',
  invalid_state: 'The connection request expired or was invalid — try again.',
  save_failed: 'Google authorized wacrm, but saving the connection failed. Try again.',
  exchange_failed: 'Could not complete the Google authorization. Try again.',
};

export function GoogleConnectionSettings() {
  const searchParams = useSearchParams();
  const [state, setState] = useState<ConnectionState>({
    loading: true,
    connected: false,
    email: null,
    serverConfigured: false,
  });
  const [disconnecting, setDisconnecting] = useState(false);

  const load = useCallback(async () => {
    try {
      const res = await fetch('/api/integrations/google', { cache: 'no-store' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Failed to load Google connection status');
        return;
      }
      const data = (await res.json()) as {
        connected: boolean;
        email: string | null;
        serverConfigured: boolean;
      };
      setState({ loading: false, ...data });
    } catch (err) {
      console.error('[GoogleConnectionSettings] load error:', err);
      toast.error('Could not reach the server');
      setState((prev) => ({ ...prev, loading: false }));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  useEffect(() => {
    if (searchParams.get('connected') === '1') {
      toast.success('Google account connected');
    }
    const googleError = searchParams.get('google_error');
    if (googleError) {
      toast.error(ERROR_MESSAGES[googleError] ?? 'Google connection failed.');
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  async function handleDisconnect() {
    setDisconnecting(true);
    try {
      const res = await fetch('/api/integrations/google', { method: 'DELETE' });
      if (!res.ok) {
        const payload = await res.json().catch(() => ({}));
        toast.error(payload.error || 'Failed to disconnect');
        return;
      }
      toast.success('Google account disconnected');
      await load();
    } catch (err) {
      console.error('[GoogleConnectionSettings] disconnect error:', err);
      toast.error('Could not reach the server');
    } finally {
      setDisconnecting(false);
    }
  }

  if (state.loading) {
    return (
      <div className="flex items-center justify-center py-12">
        <Loader2 className="text-primary size-6 animate-spin" />
      </div>
    );
  }

  return (
    <section className="animate-in fade-in-50 space-y-6 duration-200">
      <SettingsPanelHead
        title="Google"
        description="Connect your Google account once, then pick a destination Google Sheet for any product's order export from Settings → Products — no sharing, no pasted URLs."
      />

      {!state.serverConfigured ? (
        <Card>
          <CardContent className="py-6 text-sm text-muted-foreground">
            Not set up on this server yet — an admin needs to set{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">GOOGLE_OAUTH_CLIENT_ID</code>{' '}
            and{' '}
            <code className="rounded bg-muted px-1 py-0.5 text-xs">GOOGLE_OAUTH_CLIENT_SECRET</code>{' '}
            — see <code className="text-xs">.env.local.example</code>.
          </CardContent>
        </Card>
      ) : (
        <Card>
          <CardContent className="flex flex-col gap-3 py-6 sm:flex-row sm:items-center sm:justify-between">
            <div className="flex items-center gap-3">
              {state.connected && <CheckCircle2 className="size-5 shrink-0 text-emerald-400" />}
              <div>
                <p className="text-foreground text-sm font-medium">
                  {state.connected ? `Connected as ${state.email ?? 'unknown'}` : 'Not connected'}
                </p>
                {!state.connected && (
                  <p className="text-muted-foreground mt-0.5 text-xs">
                    Connect once — every product can then pick its own sheet.
                  </p>
                )}
              </div>
            </div>
            <RequireRole min="admin">
              {state.connected ? (
                <Button
                  variant="outline"
                  onClick={handleDisconnect}
                  disabled={disconnecting}
                  className="border-red-500/40 bg-red-500/10 text-red-300 hover:border-red-500/60 hover:bg-red-500/20 hover:text-red-200"
                >
                  {disconnecting ? (
                    <Loader2 className="size-4 animate-spin" />
                  ) : (
                    <Unlink className="size-4" />
                  )}
                  Disconnect
                </Button>
              ) : (
                <Button onClick={() => { window.location.href = '/api/integrations/google/connect'; }}>
                  Connect with Google
                </Button>
              )}
            </RequireRole>
          </CardContent>
        </Card>
      )}
    </section>
  );
}
