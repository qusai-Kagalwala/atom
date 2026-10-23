import { useState } from 'react';
import { CircleAlert, CircleCheck, Eye, EyeOff, Info } from 'lucide-react';

const inputClass =
  'block min-h-tap w-full rounded-btn border border-line bg-white px-3 font-ui text-ink placeholder:text-ink-3 ' +
  'focus:border-primary focus:outline-none focus:ring-2 focus:ring-primary-muted aria-[invalid=true]:border-error';

export function Field({ id, label, hint, error, children }) {
  return (
    <div>
      <label htmlFor={id} className="mb-1.5 block font-ui text-sm font-medium text-ink">
        {label}
      </label>
      {children}
      {error ? (
        <p id={`${id}-error`} className="mt-1 font-ui text-xs text-error">
          {error}
        </p>
      ) : (
        hint && <p className="mt-1 font-ui text-xs text-ink-3">{hint}</p>
      )}
    </div>
  );
}

export function TextInput({ id, error, className = '', ...props }) {
  return (
    <input
      id={id}
      aria-invalid={Boolean(error)}
      aria-describedby={error ? `${id}-error` : undefined}
      className={`${inputClass} ${className}`}
      {...props}
    />
  );
}

export function PasswordInput({ id, error, ...props }) {
  const [show, setShow] = useState(false);
  return (
    <div className="relative">
      <input
        id={id}
        type={show ? 'text' : 'password'}
        maxLength={256}
        aria-invalid={Boolean(error)}
        aria-describedby={error ? `${id}-error` : undefined}
        className={`${inputClass} pr-12`}
        {...props}
      />
      <button
        type="button"
        onClick={() => setShow((v) => !v)}
        className="absolute inset-y-0 right-0 flex min-w-tap items-center justify-center text-ink-3 hover:text-ink"
        aria-label={show ? 'Hide password' : 'Show password'}
        aria-pressed={show}
      >
        {show ? <EyeOff size={18} /> : <Eye size={18} />}
      </button>
    </div>
  );
}

const ALERT = {
  error: { Icon: CircleAlert, cls: 'border-error/20 bg-error-bg text-error', role: 'alert' },
  success: { Icon: CircleCheck, cls: 'border-success/20 bg-success-bg text-success', role: 'status' },
  info: { Icon: Info, cls: 'border-info/20 bg-info-bg text-info', role: 'status' },
};

export function Alert({ tone = 'error', children }) {
  const { Icon, cls, role } = ALERT[tone];
  return (
    <div role={role} className={`flex gap-2 rounded-btn border px-3 py-2.5 font-ui text-sm ${cls}`}>
      <Icon size={18} className="mt-px shrink-0" aria-hidden="true" />
      <div>{children}</div>
    </div>
  );
}
