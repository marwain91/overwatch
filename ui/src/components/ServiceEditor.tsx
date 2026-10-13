import { useState } from 'react';
import type { AppService } from '../lib/types';

interface ServiceEditorProps {
  service: AppService;
  onChange: (s: AppService) => void;
  onRemove: () => void;
  // The command field is a naive space split, which would mangle quoted arguments of an
  // existing service. Only the create wizard (no prior command) enables it.
  allowCommand?: boolean;
}

export function ServiceEditor({ service, onChange, onRemove, allowCommand = false }: ServiceEditorProps) {
  const [expanded, setExpanded] = useState(true);
  const [showAdvanced, setShowAdvanced] = useState(!!service.image_suffix);

  return (
    <div className="rounded-lg border border-border-subtle bg-surface-muted p-4">
      <div className="mb-3 flex items-center justify-between">
        <button onClick={() => setExpanded(!expanded)} className="text-sm font-medium text-content-secondary">
          {service.name || 'New Service'} {expanded ? '▾' : '▸'}
        </button>
        <button onClick={onRemove} className="text-xs text-red-400 hover:text-red-300">
          Remove
        </button>
      </div>

      {expanded && (
        <div className="grid grid-cols-2 gap-3">
          <div>
            <label className="label">Name</label>
            <input className="input" value={service.name} onChange={(e) => onChange({ ...service, name: e.target.value })} placeholder="backend" />
            <p className="mt-1 text-xs text-content-faint">Also used as the image name in the registry</p>
          </div>
          <div>
            <label className="label">Internal Port</label>
            <input
              className="input"
              type="number"
              value={service.ports?.internal || ''}
              onChange={(e) => onChange({ ...service, ports: { ...service.ports, internal: parseInt(e.target.value) || 0 } })}
              placeholder="3000"
            />
          </div>
          {allowCommand && (
            <div className="col-span-2">
              <label className="label">Command (optional)</label>
              <input
                className="input"
                value={service.command?.join(' ') || ''}
                onChange={(e) => onChange({ ...service, command: e.target.value ? e.target.value.split(' ') : undefined })}
                placeholder="node server.js"
              />
            </div>
          )}
          <div className="col-span-2 flex gap-4">
            <label className="flex items-center gap-2 text-sm text-content-tertiary">
              <input type="checkbox" checked={!!service.required} onChange={(e) => onChange({ ...service, required: e.target.checked })} />
              Required
            </label>
            <label className="flex items-center gap-2 text-sm text-content-tertiary">
              <input type="checkbox" checked={!!service.is_init_container} onChange={(e) => onChange({ ...service, is_init_container: e.target.checked })} />
              Init Container
            </label>
          </div>
          {showAdvanced ? (
            <div className="col-span-2">
              <label className="label">Image Name Override</label>
              <input
                className="input"
                value={service.image_suffix || ''}
                onChange={(e) => onChange({ ...service, image_suffix: e.target.value || undefined })}
                placeholder={service.name || 'defaults to service name'}
              />
              <p className="mt-1 text-xs text-content-faint">Only set if the image name differs from the service name</p>
            </div>
          ) : (
            <button className="col-span-2 text-left text-xs text-content-faint hover:text-content-muted" onClick={() => setShowAdvanced(true)}>
              Advanced options...
            </button>
          )}
        </div>
      )}
    </div>
  );
}
