import { cn } from '../lib/cn';

const sizes = {
  sm: 'max-w-sm',
  md: 'max-w-md',
  lg: 'max-w-lg',
};

export function Modal({
  title,
  size = 'lg',
  children,
  onClose,
}: {
  title: string;
  size?: 'sm' | 'md' | 'lg';
  children: React.ReactNode;
  onClose: () => void;
}) {
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center bg-surface-overlay" onClick={(e) => e.target === e.currentTarget && onClose()}>
      <div className={cn('w-full rounded-xl border border-border bg-surface-raised p-6', sizes[size])}>
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-lg font-semibold text-content-primary">{title}</h2>
          <button onClick={onClose} className="text-content-faint hover:text-content-tertiary">&times;</button>
        </div>
        {children}
      </div>
    </div>
  );
}
