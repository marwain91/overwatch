import { useState, useRef, useEffect } from 'react';
import { useAppTags } from '../hooks/useApps';

export function TagInput({ appId, value, onChange }: { appId: string; value: string; onChange: (v: string) => void }) {
  const [open, setOpen] = useState(false);
  const { data: tagsData, isLoading, isError, refetch } = useAppTags(appId);
  const wrapperRef = useRef<HTMLDivElement>(null);

  const tags = tagsData?.tags || [];

  // Close dropdown on outside click
  useEffect(() => {
    if (!open) return;
    const handler = (e: MouseEvent) => {
      if (wrapperRef.current && !wrapperRef.current.contains(e.target as Node)) {
        setOpen(false);
      }
    };
    document.addEventListener('mousedown', handler);
    return () => document.removeEventListener('mousedown', handler);
  }, [open]);

  const handleBrowse = () => {
    if (!open) refetch();
    setOpen(!open);
  };

  return (
    <div ref={wrapperRef} className="relative">
      <div className="flex gap-2">
        <input
          className="input flex-1"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder="latest"
        />
        <button
          type="button"
          className="btn btn-secondary whitespace-nowrap"
          onClick={handleBrowse}
        >
          Browse tags
        </button>
      </div>

      {open && (
        <div className="absolute right-0 z-10 mt-1 w-64 rounded-lg border border-border bg-surface-raised shadow-lg">
          {isLoading ? (
            <div className="flex justify-center py-4"><span className="spinner spinner-sm" /></div>
          ) : isError ? (
            <p className="px-3 py-3 text-xs text-content-faint">
              Could not fetch tags from registry. You can type a tag manually.
            </p>
          ) : tags.length === 0 ? (
            <p className="px-3 py-3 text-xs text-content-faint">No tags found.</p>
          ) : (
            <ul className="max-h-48 overflow-y-auto py-1">
              {tags.map((t) => (
                <li key={t}>
                  <button
                    type="button"
                    className={`w-full px-3 py-1.5 text-left text-sm transition-colors hover:bg-surface-subtle ${
                      t === value ? 'text-brand-400 font-medium' : 'text-content-secondary'
                    }`}
                    onClick={() => { onChange(t); setOpen(false); }}
                  >
                    {t}
                  </button>
                </li>
              ))}
            </ul>
          )}
        </div>
      )}
    </div>
  );
}
