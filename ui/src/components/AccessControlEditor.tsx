import { useState } from 'react';
import type { AccessControl } from '../lib/types';
import { Modal } from './Modal';

type DraftRule = { action: 'allow' | 'deny'; description: string; path: string; ranges: string };
const field = 'w-full rounded-lg border border-border bg-surface-base px-3 py-2 text-sm text-content-primary focus:border-brand-500 focus:outline-none';
const emptyRule = (): DraftRule => ({ action: 'allow', description: '', path: '', ranges: '' });

export function AccessControlEditor({ initial, onClose, onSubmit }: {
  initial?: AccessControl;
  onClose: () => void;
  onSubmit: (policy: AccessControl | undefined) => Promise<void>;
}) {
  const [enabled, setEnabled] = useState(!!initial);
  const [fallback, setFallback] = useState<'allow' | 'deny'>(initial?.default_action ?? 'deny');
  const [rules, setRules] = useState<DraftRule[]>(initial?.rules.map(rule => ({
    action: rule.action, description: rule.description ?? '', path: rule.path_regex ?? '', ranges: rule.source_ranges?.join('\n') ?? '',
  })) ?? []);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const change = (index: number, patch: Partial<DraftRule>) => setRules(list => list.map((rule, i) => i === index ? { ...rule, ...patch } : rule));
  const move = (index: number, direction: number) => setRules(list => {
    const next = [...list];
    [next[index], next[index + direction]] = [next[index + direction], next[index]];
    return next;
  });
  const submit = async () => {
    setError('');
    const policy: AccessControl | undefined = enabled ? {
      default_action: fallback,
      rules: rules.map(rule => ({
        action: rule.action,
        ...(rule.description.trim() ? { description: rule.description.trim() } : {}),
        ...(rule.path ? { path_regex: rule.path } : {}),
        ...(rule.ranges.trim() ? { source_ranges: rule.ranges.split(/[,\n]/).map(s => s.trim()).filter(Boolean) } : {}),
      })),
    } : undefined;
    if (policy?.rules.some(rule => !rule.path_regex && !rule.source_ranges?.length)) {
      setError('Every rule needs a path regex, IP ranges, or both. Use the fallback action for unmatched requests.');
      return;
    }
    setSaving(true);
    try { await onSubmit(policy); onClose(); }
    catch (err: any) { setError(err?.message || 'Save failed'); }
    finally { setSaving(false); }
  };
  return (
    <Modal title="URL and IP access rules" size="xl" maxHeight onClose={saving ? () => {} : onClose}>
      <div className="space-y-4 overflow-y-auto pr-1">
        <label className="flex items-center gap-2 text-sm text-content-primary">
          <input type="checkbox" checked={enabled} onChange={e => setEnabled(e.target.checked)} disabled={saving} /> Enable app access policy
        </label>
        <p className="text-xs text-content-muted">Applies to every routed service and host alias in this app. First matching rule wins. Within a rule, path and IP conditions must both match; IP ranges match any listed range.</p>
        <p className="text-xs text-content-muted">Path regexes use Go/RE2 syntax and match the original path before prefix stripping, without the query string. Anchor exact paths with ^ and $. IP conditions use the direct client IP or trusted PROXY protocol, never X-Forwarded-For.</p>
        <fieldset disabled={!enabled || saving} className="space-y-4 disabled:opacity-50">
          <div className="flex flex-wrap gap-2">
            <button type="button" className="text-xs text-brand-400" onClick={() => {
              setFallback('deny');
              setRules([
                { ...emptyRule(), description: 'Public health check', path: '^/health$' },
                { ...emptyRule(), description: 'Office or VPN — replace these example ranges', ranges: '203.0.113.0/24\n2001:db8:1234::/48' },
              ]);
            }}>Use private app example</button>
            <button type="button" className="text-xs text-brand-400" onClick={() => {
              setFallback('allow'); setRules([{ ...emptyRule(), action: 'deny', description: 'Blocked paths', path: '^/(internal|debug)(/|$)' }]);
            }}>Use URL blacklist example</button>
          </div>
          {rules.map((rule, i) => (
            <div key={i} className="space-y-3 rounded-lg border border-border p-3">
              <div className="flex items-center justify-between gap-2">
                <label className="flex items-center gap-2 text-sm text-content-primary">
                  Rule {i + 1}
                  <select aria-label={`Rule ${i + 1} action`} className={field} value={rule.action} onChange={e => change(i, { action: e.target.value as 'allow' | 'deny' })}>
                    <option value="allow">Allow</option><option value="deny">Deny</option>
                  </select>
                </label>
                <div className="flex gap-3 text-xs text-content-muted">
                  <button type="button" disabled={i === 0} onClick={() => move(i, -1)} aria-label={`Move rule ${i + 1} up`}>Up</button>
                  <button type="button" disabled={i === rules.length - 1} onClick={() => move(i, 1)} aria-label={`Move rule ${i + 1} down`}>Down</button>
                  <button type="button" className="text-red-400" onClick={() => setRules(list => list.filter((_, index) => index !== i))}>Remove</button>
                </div>
              </div>
              <input aria-label={`Rule ${i + 1} description`} className={field} value={rule.description} maxLength={200} placeholder="Description (optional)" onChange={e => change(i, { description: e.target.value })} />
              <label className="block text-xs text-content-muted">Path regex (optional)
                <input className={`${field} mt-1 font-mono`} value={rule.path} maxLength={1024} placeholder="^/api/webhooks/provider$" onChange={e => change(i, { path: e.target.value })} />
              </label>
              <label className="block text-xs text-content-muted">Client IPs / CIDRs (optional, one per line or comma-separated)
                <textarea className={`${field} mt-1 font-mono`} rows={2} value={rule.ranges} placeholder={'203.0.113.0/24\n2001:db8::/32'} onChange={e => change(i, { ranges: e.target.value })} />
              </label>
              <p className="text-xs text-content-faint">Omit IPs to match this path for everyone. Omit the path to match these IPs on every URL.</p>
            </div>
          ))}
          <button type="button" disabled={rules.length >= 50} onClick={() => setRules(list => [...list, emptyRule()])} className="text-sm text-brand-400">Add rule</button>
          <label className="block text-xs text-content-muted">When no rule matches
            <select className={`${field} mt-1`} value={fallback} onChange={e => setFallback(e.target.value as 'allow' | 'deny')}>
              <option value="deny">Deny</option><option value="allow">Allow</option>
            </select>
          </label>
        </fieldset>
        <p className="text-xs text-content-muted">Allow rules pass this policy; authentication and other middlewares still apply. A deny rule can be overridden by an earlier allow rule. Restart each existing tenant from Overwatch after saving to apply changes, including when disabling this policy.</p>
        {error && <p role="alert" className="text-sm text-red-400">{error}</p>}
      </div>
      <div className="mt-4 flex justify-end gap-3">
        <button onClick={onClose} disabled={saving} className="text-sm text-content-muted">Cancel</button>
        <button onClick={submit} disabled={saving} className="rounded-lg bg-brand-600 px-4 py-2 text-sm text-white disabled:opacity-50">{saving ? 'Saving…' : 'Save policy'}</button>
      </div>
    </Modal>
  );
}
