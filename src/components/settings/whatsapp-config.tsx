'use client';

import { useEffect, useRef, useState, useCallback } from 'react';
import { toast } from 'sonner';
import {
  Eye,
  EyeOff,
  Copy,
  CheckCircle2,
  XCircle,
  Loader2,
  ExternalLink,
  Zap,
  AlertTriangle,
  Star,
  Plus,
  Trash2,
} from 'lucide-react';
import { useAuth } from '@/hooks/use-auth';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Card, CardContent, CardHeader, CardTitle, CardDescription } from '@/components/ui/card';
import { Alert, AlertDescription, AlertTitle } from '@/components/ui/alert';
import { Badge } from '@/components/ui/badge';
import { SettingsPanelHead } from './settings-panel-head';
import {
  Accordion,
  AccordionItem,
  AccordionTrigger,
  AccordionContent,
} from '@/components/ui/accordion';
import type { WhatsAppConfig as WhatsAppConfigType } from '@/types';

const MASKED_TOKEN = '••••••••••••••••';
const MAX_NUMBERS = 4;

type ConnectionStatus = 'connected' | 'disconnected' | 'unknown';
type ResetReason = 'token_corrupted' | 'meta_api_error' | null;
type RegistrationProbe = {
  live: boolean;
  checks: Record<string, boolean | null>;
  errors?: string[];
  last_registration_error?: string | null;
  registered_at?: string | null;
  subscribed_apps_at?: string | null;
};

/** Same URL for every number — Meta routes inbound to it by
 *  phone_number_id, so it's shown once, not per card. */
function WebhookUrlCard() {
  const webhookUrl =
    typeof window !== 'undefined'
      ? `${window.location.origin}/api/whatsapp/webhook`
      : '';

  function handleCopy() {
    navigator.clipboard.writeText(webhookUrl);
    toast.success('Webhook URL copied to clipboard');
  }

  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground">Webhook Configuration</CardTitle>
        <CardDescription className="text-muted-foreground">
          Use this URL as the webhook callback for every number you connect below —
          Meta routes each number&apos;s events here automatically.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <div className="space-y-2">
          <Label className="text-muted-foreground">Webhook Callback URL</Label>
          <div className="flex gap-2">
            <Input
              readOnly
              value={webhookUrl}
              className="bg-muted border-border text-muted-foreground font-mono text-sm"
            />
            <Button
              variant="outline"
              size="icon"
              onClick={handleCopy}
              className="shrink-0 border-border text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              <Copy className="size-4" />
            </Button>
          </div>
        </div>
      </CardContent>
    </Card>
  );
}

function SetupInstructions() {
  return (
    <Card>
      <CardHeader>
        <CardTitle className="text-foreground text-base">Setup Instructions</CardTitle>
        <CardDescription className="text-muted-foreground">
          Follow these steps to connect a WhatsApp Business number.
        </CardDescription>
      </CardHeader>
      <CardContent>
        <Accordion>
          <AccordionItem className="border-border">
            <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
              <span className="flex items-center gap-2">
                <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">1</span>
                Create a Meta App
              </span>
            </AccordionTrigger>
            <AccordionContent className="text-muted-foreground">
              <ol className="list-decimal list-inside space-y-1 text-sm">
                <li>Go to <span className="text-primary">developers.facebook.com</span></li>
                <li>Click &quot;My Apps&quot; and then &quot;Create App&quot;</li>
                <li>Select &quot;Business&quot; as the app type</li>
                <li>Fill in app details and create</li>
              </ol>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem className="border-border">
            <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
              <span className="flex items-center gap-2">
                <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">2</span>
                Add WhatsApp Product
              </span>
            </AccordionTrigger>
            <AccordionContent className="text-muted-foreground">
              <ol className="list-decimal list-inside space-y-1 text-sm">
                <li>In your app dashboard, click &quot;Add Product&quot;</li>
                <li>Find &quot;WhatsApp&quot; and click &quot;Set Up&quot;</li>
                <li>Follow the setup wizard to link your business</li>
              </ol>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem className="border-border">
            <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
              <span className="flex items-center gap-2">
                <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">3</span>
                Get API Credentials
              </span>
            </AccordionTrigger>
            <AccordionContent className="text-muted-foreground">
              <ol className="list-decimal list-inside space-y-1 text-sm">
                <li>Go to WhatsApp &gt; API Setup</li>
                <li>Copy your <strong className="text-foreground">Phone Number ID</strong></li>
                <li>Copy your <strong className="text-foreground">WhatsApp Business Account ID</strong></li>
                <li>Generate a <strong className="text-foreground">Permanent Access Token</strong> from Business Settings &gt; System Users</li>
              </ol>
            </AccordionContent>
          </AccordionItem>

          <AccordionItem className="border-border">
            <AccordionTrigger className="text-muted-foreground hover:text-foreground hover:no-underline">
              <span className="flex items-center gap-2">
                <span className="flex size-5 items-center justify-center rounded-full bg-primary text-xs font-bold text-primary-foreground">4</span>
                Configure Webhooks
              </span>
            </AccordionTrigger>
            <AccordionContent className="text-muted-foreground">
              <ol className="list-decimal list-inside space-y-1 text-sm">
                <li>Go to WhatsApp &gt; Configuration</li>
                <li>Click &quot;Edit&quot; on the Webhook section</li>
                <li>Paste the <strong className="text-foreground">Webhook Callback URL</strong> from above</li>
                <li>Enter the same <strong className="text-foreground">Verify Token</strong> you set here</li>
                <li>Subscribe to &quot;messages&quot; webhook field</li>
              </ol>
            </AccordionContent>
          </AccordionItem>
        </Accordion>

        <div className="mt-4 pt-4 border-t border-border">
          <a
            href="https://developers.facebook.com/docs/whatsapp/cloud-api/get-started"
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1.5 text-sm text-primary hover:text-primary/80 transition-colors"
          >
            <ExternalLink className="size-3.5" />
            Meta WhatsApp API Documentation
          </a>
        </div>
      </CardContent>
    </Card>
  );
}

/**
 * One connected (or being-connected) WhatsApp number. Owns its own
 * form + connection/registration state — accounts can hold up to
 * MAX_NUMBERS of these side by side (037_whatsapp_config_multi_number.sql).
 */
function NumberCard({
  config,
  onSaved,
  onDeleted,
  onSetDefault,
  onCancelNew,
}: {
  /** Null renders the "connect a new number" form instead of a saved one. */
  config: WhatsAppConfigType | null;
  onSaved: () => void;
  onDeleted: () => void;
  onSetDefault: () => void;
  onCancelNew?: () => void;
}) {
  const isNew = config === null;

  const [label, setLabel] = useState(config?.label ?? '');
  const [phoneNumberId, setPhoneNumberId] = useState(config?.phone_number_id ?? '');
  const [wabaId, setWabaId] = useState(config?.waba_id ?? '');
  const [accessToken, setAccessToken] = useState(isNew ? '' : MASKED_TOKEN);
  const [verifyToken, setVerifyToken] = useState('');
  const [pin, setPin] = useState('');
  const [tokenEdited, setTokenEdited] = useState(isNew);
  const [showToken, setShowToken] = useState(false);

  const [saving, setSaving] = useState(false);
  const [testing, setTesting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [settingDefault, setSettingDefault] = useState(false);
  const [connectionStatus, setConnectionStatus] = useState<ConnectionStatus>('unknown');
  const [resetReason, setResetReason] = useState<ResetReason>(null);
  const [statusMessage, setStatusMessage] = useState('');
  const [verifyingRegistration, setVerifyingRegistration] = useState(false);
  const [registrationProbe, setRegistrationProbe] = useState<RegistrationProbe | null>(null);

  const isRegistered = Boolean(config?.registered_at);
  const lastRegistrationError = config?.last_registration_error ?? null;

  const testConnection = useCallback(async (id: string, { silent }: { silent?: boolean } = {}) => {
    setTesting(true);
    try {
      const res = await fetch(`/api/whatsapp/config?id=${id}`);
      const payload = await res.json();
      if (payload.connected) {
        setConnectionStatus('connected');
        setResetReason(null);
        setStatusMessage('');
        if (!silent) {
          toast.success(
            payload.phone_info?.verified_name
              ? `Connected to ${payload.phone_info.verified_name}`
              : 'API connection successful',
          );
        }
      } else {
        setConnectionStatus('disconnected');
        setResetReason(
          payload.needs_reset
            ? 'token_corrupted'
            : payload.reason === 'meta_api_error'
              ? 'meta_api_error'
              : null,
        );
        setStatusMessage(payload.message || '');
        if (!silent) toast.error(payload.message || 'API connection failed');
      }
    } catch (err) {
      console.error('Test connection error:', err);
      setConnectionStatus('disconnected');
      if (!silent) toast.error('Connection test failed. Check network and try again.');
    } finally {
      setTesting(false);
    }
  }, []);

  // Auto-probe on mount for an already-saved number (mirrors the old
  // single-form behaviour where health was checked right after load).
  useEffect(() => {
    if (config?.id) void testConnection(config.id, { silent: true });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [config?.id]);

  async function handleSave() {
    if (!phoneNumberId.trim()) {
      toast.error('Phone Number ID is required');
      return;
    }
    if (isNew && (!accessToken.trim() || !tokenEdited)) {
      toast.error('Access Token is required for initial setup');
      return;
    }

    try {
      setSaving(true);

      const payload: Record<string, unknown> = {
        id: config?.id,
        label: label.trim() || null,
        phone_number_id: phoneNumberId.trim(),
        waba_id: wabaId.trim() || null,
        verify_token: verifyToken.trim() || null,
        pin: pin.trim() || null,
      };

      if (tokenEdited && accessToken !== MASKED_TOKEN && accessToken.trim()) {
        payload.access_token = accessToken.trim();
      } else if (!isNew) {
        toast.error('Please re-enter the Access Token to save changes');
        setSaving(false);
        return;
      }

      const res = await fetch('/api/whatsapp/config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
      });

      const data = await res.json();

      if (!res.ok) {
        toast.error(data.error || 'Failed to save configuration');
        setSaving(false);
        return;
      }

      if (data.registered === false && data.registration_error) {
        toast.error(
          `Saved, but Meta couldn't register the number: ${data.registration_error}`,
          { duration: 12000 },
        );
      } else if (data.registration_skipped) {
        toast.success(
          'Credentials saved and verified. Inbound registration was skipped (no PIN) — see Registration status below.',
          { duration: 10000 },
        );
        setPin('');
      } else {
        toast.success(
          data.phone_info?.verified_name
            ? `Live — ${data.phone_info.verified_name} can now receive events.`
            : 'WhatsApp connected. Events will start flowing within a minute.',
        );
        setPin('');
      }

      onSaved();
    } catch (err) {
      console.error('Save error:', err);
      toast.error('Failed to save configuration');
    } finally {
      setSaving(false);
    }
  }

  async function handleVerifyRegistration() {
    if (!config) return;
    setVerifyingRegistration(true);
    setRegistrationProbe(null);
    try {
      const res = await fetch(`/api/whatsapp/config/verify-registration?id=${config.id}`);
      const data = (await res.json()) as RegistrationProbe;
      setRegistrationProbe(data);
      if (data.live) {
        toast.success('Number is fully wired — Meta is delivering events.');
      } else {
        toast.error(
          'Number is not fully registered. See the checks below for which step failed.',
          { duration: 8000 },
        );
      }
      onSaved();
    } catch (err) {
      console.error('verify-registration failed:', err);
      toast.error('Could not reach the verification endpoint.');
    } finally {
      setVerifyingRegistration(false);
    }
  }

  async function handleDelete() {
    if (!config) return;
    if (
      !confirm(
        `Disconnect ${config.label || config.phone_number_id}? You'll need to re-enter its credentials to reconnect it.`,
      )
    ) {
      return;
    }
    try {
      setDeleting(true);
      const res = await fetch(`/api/whatsapp/config?id=${config.id}`, { method: 'DELETE' });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to remove number');
        return;
      }
      toast.success('Number disconnected.');
      onDeleted();
    } catch (err) {
      console.error('Delete error:', err);
      toast.error('Failed to remove number');
    } finally {
      setDeleting(false);
    }
  }

  async function handleSetDefault() {
    if (!config) return;
    try {
      setSettingDefault(true);
      const res = await fetch(`/api/whatsapp/config?id=${config.id}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ is_default: true }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to set default number');
        return;
      }
      toast.success('Default number updated.');
      onSetDefault();
    } catch (err) {
      console.error('Set default error:', err);
      toast.error('Failed to set default number');
    } finally {
      setSettingDefault(false);
    }
  }

  const showResetBanner = resetReason === 'token_corrupted';

  return (
    <Card>
      <CardHeader>
        <div className="flex items-start justify-between gap-3 flex-wrap">
          <div className="flex-1 min-w-[200px] space-y-2">
            <CardTitle className="text-foreground flex items-center gap-2">
              {isNew ? (
                'Connect a new number'
              ) : (
                <>
                  {config.label || config.phone_number_id}
                  {config.is_default && (
                    <Badge variant="outline" className="border-primary/40 text-primary gap-1">
                      <Star className="size-3" />
                      Default
                    </Badge>
                  )}
                </>
              )}
            </CardTitle>
            {!isNew && (
              <Input
                placeholder="Label (e.g. Sales, Support)"
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground h-8 max-w-xs text-sm"
              />
            )}
          </div>
          <div className="flex items-center gap-2">
            {!isNew && !config.is_default && (
              <Button
                variant="outline"
                size="sm"
                onClick={handleSetDefault}
                disabled={settingDefault}
                className="border-border text-muted-foreground hover:text-foreground hover:bg-muted h-7"
              >
                {settingDefault ? <Loader2 className="size-3.5 animate-spin" /> : <Star className="size-3.5" />}
                Set as default
              </Button>
            )}
            {isNew ? (
              onCancelNew && (
                <Button
                  variant="ghost"
                  size="sm"
                  onClick={onCancelNew}
                  className="text-muted-foreground hover:text-foreground h-7"
                >
                  Cancel
                </Button>
              )
            ) : (
              <Button
                variant="outline"
                size="icon"
                onClick={handleDelete}
                disabled={deleting}
                title="Disconnect this number"
                className="size-7 border-red-900 text-red-400 hover:text-red-300 hover:bg-red-950/40"
              >
                {deleting ? <Loader2 className="size-3.5 animate-spin" /> : <Trash2 className="size-3.5" />}
              </Button>
            )}
          </div>
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Corrupted-token banner */}
        {showResetBanner && (
          <Alert className="bg-amber-950/40 border-amber-600/40">
            <div className="flex items-start gap-3">
              <AlertTriangle className="size-5 text-amber-400 mt-0.5 shrink-0" />
              <div className="flex-1">
                <AlertTitle className="text-amber-200 mb-1">
                  Stored token can&apos;t be decrypted
                </AlertTitle>
                <AlertDescription className="text-amber-100/80 text-sm">
                  {statusMessage}
                </AlertDescription>
                <p className="text-amber-100/70 text-xs mt-2">
                  Re-enter the Access Token below and save to repair it.
                </p>
              </div>
            </div>
          </Alert>
        )}

        {/* Connection status */}
        {!isNew && (
          <Alert className="bg-card border-border">
            <div className="flex items-center gap-2">
              {connectionStatus === 'connected' ? (
                <CheckCircle2 className="size-4 text-primary" />
              ) : (
                <XCircle className="size-4 text-red-500" />
              )}
              <AlertTitle className="text-foreground mb-0">
                {connectionStatus === 'connected' ? 'Credentials valid' : 'Not Connected'}
              </AlertTitle>
            </div>
            <AlertDescription className="text-muted-foreground">
              {connectionStatus === 'connected'
                ? 'This access token authenticates with Meta. See Registration status below for whether webhooks are actually wired.'
                : statusMessage || 'Testing connection…'}
            </AlertDescription>
          </Alert>
        )}

        {/* Registration status */}
        {!isNew && (
          <Alert
            className={
              isRegistered
                ? 'bg-emerald-950/30 border-emerald-700/50'
                : 'bg-amber-950/30 border-amber-700/50'
            }
          >
            <div className="flex items-center justify-between gap-2 flex-wrap">
              <div className="flex items-center gap-2">
                {isRegistered ? (
                  <CheckCircle2 className="size-4 text-emerald-400" />
                ) : (
                  <AlertTriangle className="size-4 text-amber-400" />
                )}
                <AlertTitle className={'mb-0 ' + (isRegistered ? 'text-emerald-200' : 'text-amber-200')}>
                  {isRegistered
                    ? 'Registered — Meta will deliver events to wacrm'
                    : 'Not registered — Meta will not deliver events'}
                </AlertTitle>
              </div>
              <Button
                variant="outline"
                size="sm"
                onClick={handleVerifyRegistration}
                disabled={verifyingRegistration}
                className="border-border bg-transparent text-foreground hover:bg-muted h-7"
              >
                {verifyingRegistration ? <Loader2 className="size-3.5 animate-spin" /> : <Zap className="size-3.5" />}
                Verify with Meta
              </Button>
            </div>
            <AlertDescription className="text-muted-foreground mt-2 text-xs leading-relaxed">
              {isRegistered ? (
                <>
                  Subscribed since{' '}
                  {config.registered_at ? new Date(config.registered_at).toLocaleString() : 'unknown'}.
                  Click <strong>Verify with Meta</strong> if events stop arriving.
                </>
              ) : lastRegistrationError ? (
                <>
                  Last attempt failed with:{' '}
                  <span className="text-red-300">&quot;{lastRegistrationError}&quot;</span>. Enter (or
                  correct) the 2-step PIN below and click Save to retry.
                </>
              ) : (
                <>
                  This number was saved before registration tracking existed, or registration was
                  skipped. Enter the 2-step PIN below and click Save to subscribe it.
                </>
              )}
            </AlertDescription>

            {registrationProbe && (
              <div className="mt-3 rounded border border-border bg-card/60 px-3 py-2 space-y-1.5 text-[11px]">
                <p className="font-medium text-foreground">
                  Diagnostic — last run:{' '}
                  <span className={registrationProbe.live ? 'text-emerald-400' : 'text-amber-400'}>
                    {registrationProbe.live ? 'live' : 'not live'}
                  </span>
                </p>
                <ul className="space-y-0.5 text-muted-foreground">
                  {Object.entries(registrationProbe.checks).map(([k, v]) => (
                    <li key={k} className="flex items-center gap-1.5">
                      {v === true ? (
                        <CheckCircle2 className="size-3 text-emerald-400 shrink-0" />
                      ) : v === false ? (
                        <XCircle className="size-3 text-red-400 shrink-0" />
                      ) : (
                        <span className="size-3 rounded-full border border-border shrink-0" />
                      )}
                      <code className="text-muted-foreground">{k}</code>
                    </li>
                  ))}
                </ul>
                {(registrationProbe.errors ?? []).length > 0 && (
                  <ul className="pt-1 space-y-0.5 text-red-300">
                    {registrationProbe.errors?.map((e, i) => (
                      <li key={i}>• {e}</li>
                    ))}
                  </ul>
                )}
              </div>
            )}
          </Alert>
        )}

        {isNew && (
          <div className="space-y-2">
            <Label className="text-muted-foreground">Label (optional)</Label>
            <Input
              placeholder="e.g. Sales, Support"
              value={label}
              onChange={(e) => setLabel(e.target.value)}
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
            />
          </div>
        )}

        <div className="space-y-2">
          <Label className="text-muted-foreground">Phone Number ID</Label>
          <Input
            placeholder="e.g. 100234567890123"
            value={phoneNumberId}
            onChange={(e) => setPhoneNumberId(e.target.value)}
            className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
          />
        </div>

        <div className="space-y-2">
          <Label className="text-muted-foreground">WhatsApp Business Account ID</Label>
          <Input
            placeholder="e.g. 100234567890456"
            value={wabaId}
            onChange={(e) => setWabaId(e.target.value)}
            className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
          />
        </div>

        <div className="space-y-2">
          <Label className="text-muted-foreground">Permanent Access Token</Label>
          <div className="relative">
            <Input
              type={showToken ? 'text' : 'password'}
              placeholder="Enter your access token"
              value={accessToken}
              onChange={(e) => {
                setAccessToken(e.target.value);
                setTokenEdited(true);
              }}
              onFocus={() => {
                if (accessToken === MASKED_TOKEN) {
                  setAccessToken('');
                  setTokenEdited(true);
                }
              }}
              className="bg-muted border-border text-foreground placeholder:text-muted-foreground pr-10"
            />
            <button
              type="button"
              onClick={() => setShowToken(!showToken)}
              className="absolute right-2 top-1/2 -translate-y-1/2 text-muted-foreground hover:text-foreground transition-colors"
            >
              {showToken ? <EyeOff className="size-4" /> : <Eye className="size-4" />}
            </button>
          </div>
          {!isNew && !tokenEdited && (
            <p className="text-xs text-muted-foreground">
              Token is hidden for security. Re-enter it to update this number.
            </p>
          )}
        </div>

        <div className="space-y-2">
          <Label className="text-muted-foreground">Webhook Verify Token</Label>
          <Input
            placeholder="Create a custom verify token"
            value={verifyToken}
            onChange={(e) => setVerifyToken(e.target.value)}
            className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
          />
          <p className="text-xs text-muted-foreground">
            A custom string you create. Must match the token you set in Meta webhook settings.
          </p>
        </div>

        <div className="space-y-2">
          <Label className="text-muted-foreground">
            Two-step verification PIN
            <span className="ml-1 text-muted-foreground">(optional)</span>
          </Label>
          <Input
            type="text"
            inputMode="numeric"
            maxLength={6}
            placeholder="6-digit PIN from Meta WhatsApp Manager"
            value={pin}
            onChange={(e) => setPin(e.target.value.replace(/\D/g, '').slice(0, 6))}
            className="bg-muted border-border text-foreground placeholder:text-muted-foreground tracking-widest"
          />
          <p className="text-xs text-muted-foreground leading-relaxed">
            Needed only to wire <strong className="text-muted-foreground">inbound</strong> messages for
            a <strong className="text-muted-foreground">production</strong> number. Set it in{' '}
            <strong className="text-muted-foreground">
              Meta Business Manager → WhatsApp Accounts → Phone Numbers → Two-step verification
            </strong>
            , then paste it here so wacrm can subscribe the number — otherwise Meta routes inbound
            events to whichever app last claimed it (the symptom that hits second numbers under a
            shared WABA). <strong className="text-muted-foreground">Meta test numbers</strong> have no
            PIN and are pre-registered — leave this blank for them. Leaving it blank also keeps an
            existing registration untouched.
          </p>
        </div>

        <div className="flex flex-wrap gap-3 pt-2">
          <Button
            onClick={handleSave}
            disabled={saving}
            className="bg-primary hover:bg-primary/90 text-primary-foreground"
          >
            {saving ? (
              <>
                <Loader2 className="size-4 animate-spin" />
                Saving...
              </>
            ) : isNew ? (
              'Connect number'
            ) : (
              'Save Configuration'
            )}
          </Button>
          {!isNew && (
            <Button
              variant="outline"
              onClick={() => testConnection(config.id)}
              disabled={testing}
              className="border-border text-muted-foreground hover:text-foreground hover:bg-muted"
            >
              {testing ? (
                <>
                  <Loader2 className="size-4 animate-spin" />
                  Testing...
                </>
              ) : (
                <>
                  <Zap className="size-4" />
                  Test API Connection
                </>
              )}
            </Button>
          )}
        </div>
      </CardContent>
    </Card>
  );
}

type QrStatus = 'qr_pending' | 'connecting' | 'connected' | 'disconnected' | 'logged_out';

/**
 * A QR-linked ("beta") WhatsApp number — pairs like WhatsApp Web instead
 * of going through Meta's official Cloud API. Meant for testing a new
 * product/business line cheaply before committing to official
 * onboarding; see 047_whatsapp_qr_provider.sql. Kept as its own
 * component (not folded into NumberCard) since the connection lifecycle
 * — generate QR, poll, scan, done — has nothing in common with the
 * Cloud API credential form.
 */
function QrNumberCard({
  config,
  onSaved,
  onDeleted,
}: {
  config: WhatsAppConfigType | null;
  onSaved: () => void;
  onDeleted: () => void;
}) {
  const isNew = config === null;
  const [label, setLabel] = useState(config?.label ?? '');
  const [starting, setStarting] = useState(false);
  const [deleting, setDeleting] = useState(false);
  const [configId, setConfigId] = useState<string | null>(config?.id ?? null);
  const [status, setStatus] = useState<QrStatus | null>(null);
  const [qrImage, setQrImage] = useState<string | null>(null);
  const [linkedPhone, setLinkedPhone] = useState<string | null>(null);
  const pollRef = useRef<ReturnType<typeof setInterval> | null>(null);
  // Guards against a remount loop: onSaved() (fetchConfigs) flips the
  // parent's `loading` flag, which unmounts/remounts every card in the
  // list — including this one. Without this guard, an already-connected
  // card would re-detect "connected" on every remount and call onSaved()
  // again, causing the whole list to flash/reload forever.
  const notifiedConnectedRef = useRef(false);

  const stopPolling = useCallback(() => {
    if (pollRef.current) {
      clearInterval(pollRef.current);
      pollRef.current = null;
    }
  }, []);

  const poll = useCallback(
    async (id: string) => {
      try {
        const res = await fetch(`/api/whatsapp/qr-config/${id}/status`);
        if (!res.ok) return;
        const data = await res.json();
        setStatus(data.status);
        setQrImage(data.qr ?? null);
        setLinkedPhone(data.linked_phone_number ?? null);
        if (data.status === 'connected') {
          stopPolling();
          if (!notifiedConnectedRef.current) {
            notifiedConnectedRef.current = true;
            toast.success('WhatsApp connected via QR');
            onSaved();
          }
        }
      } catch (err) {
        console.error('qr status poll error:', err);
      }
    },
    [onSaved, stopPolling],
  );

  useEffect(() => {
    if (!configId) return;
    // Already connected (a saved card, not a fresh pairing) — nothing to
    // poll for until the user explicitly disconnects/reconnects.
    if (config?.status === 'connected') return;
    void poll(configId);
    pollRef.current = setInterval(() => void poll(configId), 2000);
    return stopPolling;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [configId]);

  async function handleGenerate() {
    setStarting(true);
    try {
      const res = await fetch('/api/whatsapp/qr-config', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ label: label.trim() || null }),
      });
      const data = await res.json();
      if (!res.ok) {
        toast.error(data.error || 'Failed to start pairing');
        return;
      }
      setConfigId(data.id);
    } catch (err) {
      console.error('qr generate error:', err);
      toast.error('Failed to start pairing');
    } finally {
      setStarting(false);
    }
  }

  async function handleDisconnect() {
    if (!configId) return;
    if (!confirm('Disconnect this WhatsApp number? You will need to scan a new QR to reconnect.')) return;
    setDeleting(true);
    try {
      const res = await fetch(`/api/whatsapp/qr-config?id=${configId}`, { method: 'DELETE' });
      if (!res.ok) {
        const data = await res.json();
        toast.error(data.error || 'Failed to disconnect');
        return;
      }
      stopPolling();
      onDeleted();
    } catch (err) {
      console.error('qr disconnect error:', err);
      toast.error('Failed to disconnect');
    } finally {
      setDeleting(false);
    }
  }

  const effectiveStatus = status ?? (config?.status === 'connected' ? 'connected' : 'qr_pending');

  return (
    <Card>
      <CardHeader>
        <div className="flex items-center justify-between gap-2">
          <div>
            <CardTitle className="text-foreground flex items-center gap-2">
              {config?.label || (isNew ? 'New number (QR)' : 'WhatsApp number (QR)')}
              <Badge variant="outline" className="text-xs">beta</Badge>
            </CardTitle>
            <CardDescription className="text-muted-foreground">
              Pairs like WhatsApp Web — no Meta Business account needed. For testing a
              product cheaply before moving it to the official API.
            </CardDescription>
          </div>
          {effectiveStatus === 'connected' ? (
            <Badge className="bg-green-600/15 text-green-600 border-green-600/30">
              <CheckCircle2 className="size-3.5" /> Connected
            </Badge>
          ) : (
            <Badge variant="outline" className="text-muted-foreground">
              <XCircle className="size-3.5" /> {effectiveStatus.replace('_', ' ')}
            </Badge>
          )}
        </div>
      </CardHeader>
      <CardContent className="space-y-4">
        <Alert>
          <AlertTriangle className="size-4" />
          <AlertTitle>Ban risk</AlertTitle>
          <AlertDescription>
            This uses an unofficial protocol. Use a spare/burner number, not your main one, and
            keep volume low while testing — Meta can restrict numbers that send too fast or in
            bulk. Broadcasts and message templates aren&apos;t available on QR-connected numbers.
          </AlertDescription>
        </Alert>

        {isNew && !configId && (
          <div className="space-y-3">
            <div className="space-y-2">
              <Label className="text-muted-foreground">Label (optional)</Label>
              <Input
                value={label}
                onChange={(e) => setLabel(e.target.value)}
                placeholder="e.g. Product test"
                className="bg-muted border-border text-foreground placeholder:text-muted-foreground"
              />
            </div>
            <Button onClick={handleGenerate} disabled={starting}>
              {starting ? <Loader2 className="size-4 animate-spin" /> : null}
              Generate QR
            </Button>
          </div>
        )}

        {configId && effectiveStatus !== 'connected' && (
          <div className="flex flex-col items-center gap-3 py-4">
            {qrImage ? (
              // eslint-disable-next-line @next/next/no-img-element
              <img src={qrImage} alt="Scan with WhatsApp" className="size-64 rounded-lg border border-border" />
            ) : (
              <div className="flex size-64 items-center justify-center rounded-lg border border-dashed border-border">
                <Loader2 className="size-6 animate-spin text-muted-foreground" />
              </div>
            )}
            <p className="text-xs text-muted-foreground text-center max-w-xs">
              Open WhatsApp on the phone you want to connect → Settings → Linked devices → Link a
              device, then scan this code.
            </p>
          </div>
        )}

        {effectiveStatus === 'connected' && (linkedPhone || config?.phone_number_id) && (
          <p className="text-sm text-muted-foreground">
            Linked number: <span className="text-foreground font-mono">{linkedPhone}</span>
          </p>
        )}

        {!isNew && (
          <Button
            variant="outline"
            onClick={handleDisconnect}
            disabled={deleting}
            className="border-border text-destructive hover:bg-destructive/10"
          >
            {deleting ? <Loader2 className="size-4 animate-spin" /> : <Trash2 className="size-4" />}
            Disconnect
          </Button>
        )}
      </CardContent>
    </Card>
  );
}

export function WhatsAppConfig() {
  const { user, accountId, loading: authLoading, profileLoading } = useAuth();

  const [loading, setLoading] = useState(true);
  const [configs, setConfigs] = useState<WhatsAppConfigType[]>([]);
  const [addingNew, setAddingNew] = useState<'cloud_api' | 'qr' | null>(null);
  const loadedAccountIdRef = useRef<string | null>(null);

  const fetchConfigs = useCallback(async () => {
    setLoading(true);
    try {
      const res = await fetch('/api/whatsapp/config');
      const data = await res.json();
      setConfigs((data.configs as WhatsAppConfigType[]) ?? []);
    } catch (err) {
      console.error('fetchConfigs error:', err);
      toast.error('Failed to load WhatsApp configuration');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    // Need both the auth session (`!authLoading`) AND the profile
    // (`!profileLoading`, which carries `accountId`). Without the
    // second guard, the effect would fire with `accountId === null`
    // for the first render window and bail without ever retrying
    // once the profile arrives.
    if (authLoading || profileLoading) return;
    if (!user || !accountId) {
      loadedAccountIdRef.current = null;
      setLoading(false);
      return;
    }
    if (loadedAccountIdRef.current === accountId) return;
    loadedAccountIdRef.current = accountId;
    fetchConfigs();
  }, [authLoading, profileLoading, user?.id, accountId, fetchConfigs]);

  const canAddMore = configs.length < MAX_NUMBERS;

  return (
    <section className="animate-in fade-in-50 duration-200">
      <SettingsPanelHead
        title="WhatsApp connection"
        description="Connect up to 4 Meta WhatsApp Business numbers. Credentials, webhook, and setup steps all live here."
      />
      <div className="grid gap-6 lg:grid-cols-[1fr_380px]">
        <div className="space-y-6">
          <WebhookUrlCard />

          {loading ? (
            <div className="flex items-center justify-center py-12">
              <Loader2 className="size-6 animate-spin text-primary" />
            </div>
          ) : (
            <>
              {configs.map((c) =>
                c.provider === 'qr' ? (
                  <QrNumberCard key={c.id} config={c} onSaved={fetchConfigs} onDeleted={fetchConfigs} />
                ) : (
                  <NumberCard
                    key={c.id}
                    config={c}
                    onSaved={fetchConfigs}
                    onDeleted={fetchConfigs}
                    onSetDefault={fetchConfigs}
                  />
                ),
              )}

              {addingNew === 'cloud_api' && (
                <NumberCard
                  config={null}
                  onSaved={() => {
                    setAddingNew(null);
                    fetchConfigs();
                  }}
                  onDeleted={fetchConfigs}
                  onSetDefault={fetchConfigs}
                  onCancelNew={() => setAddingNew(null)}
                />
              )}

              {addingNew === 'qr' && (
                <QrNumberCard
                  config={null}
                  onSaved={() => {
                    setAddingNew(null);
                    fetchConfigs();
                  }}
                  onDeleted={() => setAddingNew(null)}
                />
              )}

              {!addingNew && canAddMore && (
                <div className="flex flex-wrap gap-3">
                  <Button
                    variant="outline"
                    onClick={() => setAddingNew('cloud_api')}
                    className="border-dashed border-border text-muted-foreground hover:text-foreground hover:bg-muted"
                  >
                    <Plus className="size-4" />
                    Add number (Official API)
                  </Button>
                  <Button
                    variant="outline"
                    onClick={() => setAddingNew('qr')}
                    className="border-dashed border-border text-muted-foreground hover:text-foreground hover:bg-muted"
                  >
                    <Plus className="size-4" />
                    Add number (QR — beta)
                  </Button>
                </div>
              )}

              {!canAddMore && (
                <p className="text-xs text-muted-foreground">
                  Maximum of {MAX_NUMBERS} numbers reached. Disconnect one to add another.
                </p>
              )}
            </>
          )}
        </div>

        <div>
          <SetupInstructions />
        </div>
      </div>
    </section>
  );
}
