import { useEffect, useMemo, useRef } from 'react';
import { Camera, X } from 'lucide-react';

const ACCEPT = ['image/jpeg', 'image/png', 'image/webp'];
const MAX_BYTES = 10 * 1024 * 1024;

// Picks up to `max` photos (JPG/PNG/WebP, ≤ 10 MB). The server re-checks everything.
// `files` / `onChange` are controlled by the parent; `onError` gets a message for rejected picks.
export default function PhotoPicker({ files, onChange, max, onError, disabled }) {
  const input = useRef(null);
  const previews = useMemo(() => files.map((f) => ({ file: f, url: URL.createObjectURL(f) })), [files]);

  useEffect(() => () => previews.forEach((p) => URL.revokeObjectURL(p.url)), [previews]);

  function add(e) {
    const picked = Array.from(e.target.files || []);
    e.target.value = '';
    const ok = [];
    for (const f of picked) {
      if (!ACCEPT.includes(f.type)) onError?.(`${f.name}: photos must be JPG, PNG or WebP.`);
      else if (f.size > MAX_BYTES) onError?.(`${f.name}: each photo must be 10 MB or smaller.`);
      else ok.push(f);
    }
    const room = Math.max(0, max - files.length);
    if (ok.length > room) onError?.(`You can add ${room} more photo${room === 1 ? '' : 's'}.`);
    if (ok.length) onChange([...files, ...ok.slice(0, room)]);
  }

  const remove = (i) => onChange(files.filter((_, j) => j !== i));
  const full = files.length >= max;

  return (
    <div>
      <div className="flex flex-wrap gap-2">
        {previews.map((p, i) => (
          <div key={p.url} className="relative">
            <img src={p.url} alt={p.file.name} className="h-20 w-20 rounded-btn border border-line object-cover" />
            <button
              type="button"
              onClick={() => remove(i)}
              disabled={disabled}
              className="absolute -right-2 -top-2 flex h-7 w-7 items-center justify-center rounded-full border border-line bg-white text-ink-2 shadow hover:text-error"
              aria-label={`Remove ${p.file.name}`}
            >
              <X size={14} />
            </button>
          </div>
        ))}
        {!full && (
          <button
            type="button"
            onClick={() => input.current?.click()}
            disabled={disabled}
            className="flex h-20 w-20 flex-col items-center justify-center gap-1 rounded-btn border border-dashed border-line-dark bg-white font-ui text-xs text-ink-2 hover:border-primary hover:text-primary disabled:opacity-60"
          >
            <Camera size={20} aria-hidden="true" />
            Add photo
          </button>
        )}
      </div>
      <input
        ref={input}
        type="file"
        accept={ACCEPT.join(',')}
        multiple
        className="hidden"
        onChange={add}
        tabIndex={-1}
        aria-hidden="true"
      />
      <p className="mt-1 font-ui text-xs text-ink-3">
        {files.length}/{max} · JPG, PNG or WebP, up to 10 MB each. Location data is removed.
      </p>
    </div>
  );
}
