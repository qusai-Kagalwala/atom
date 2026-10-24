import { useEffect, useState } from 'react';
import { ImageOff, LoaderCircle } from 'lucide-react';
import { fetchAttachment } from '../api/requests';

// <img> for a protected photo: fetched with the login token, shown from a blob URL.
export default function AuthImage({ url, alt, className = '', onClick }) {
  const [state, setState] = useState({ src: null, failed: false });

  useEffect(() => {
    let objectUrl = null;
    let cancelled = false;
    fetchAttachment(url)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ src: objectUrl, failed: false });
      })
      .catch(() => !cancelled && setState({ src: null, failed: true }));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url]);

  if (state.failed) {
    return (
      <div className={`flex items-center justify-center bg-cream-dark text-ink-3 ${className}`} role="img" aria-label="Photo could not be loaded">
        <ImageOff size={20} aria-hidden="true" />
      </div>
    );
  }
  if (!state.src) {
    return (
      <div className={`flex items-center justify-center bg-cream-dark text-ink-3 ${className}`} aria-hidden="true">
        <LoaderCircle size={20} className="animate-spin" />
      </div>
    );
  }
  const img = <img src={state.src} alt={alt} className={`object-cover ${className}`} />;
  return onClick ? (
    <button type="button" onClick={() => onClick(state.src)} className="block overflow-hidden rounded-btn focus-visible:ring-2 focus-visible:ring-primary">
      {img}
    </button>
  ) : (
    img
  );
}
