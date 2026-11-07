import { useEffect, useState } from 'react';
import { ImageOff, LoaderCircle, RotateCw } from 'lucide-react';
import { fetchAttachment } from '../api/requests';

// Can this browser show WebP? (Photos are stored as WebP; older iPhones can't show it.) Checked once.
let webpCheck = null;
function webpSupported() {
  if (!webpCheck) {
    webpCheck = new Promise((resolve) => {
      try {
        const img = new Image();
        img.onload = () => resolve(img.width === 1);
        img.onerror = () => resolve(false);
        img.src = 'data:image/webp;base64,UklGRiIAAABXRUJQVlA4IBYAAAAwAQCdASoBAAEADsD+JaQAA3AAAAAA';
      } catch {
        resolve(false);
      }
    });
  }
  return webpCheck;
}

const wait = (ms) => new Promise((r) => setTimeout(r, ms));

// One try, then one more after a pause (phones on a weak connection), asking for JPEG when WebP can't be shown.
async function loadPhoto(url, forceJpeg) {
  const asJpeg = forceJpeg || !(await webpSupported());
  const src = asJpeg ? `${url}${url.includes('?') ? '&' : '?'}format=jpeg` : url;
  try {
    return await fetchAttachment(src);
  } catch (err) {
    if (err?.response?.status === 404) throw err; // gone — trying again won't help
    await wait(1500);
    return fetchAttachment(src);
  }
}

// <img> for a protected photo: fetched with the login token, shown from a blob URL.
// If it can't load, it says so and can be tapped to try again.
export default function AuthImage({ url, alt, className = '', onClick }) {
  const [attempt, setAttempt] = useState(0);
  const [forceJpeg, setForceJpeg] = useState(false); // the browser got WebP but couldn't show it
  const [result, setResult] = useState({ key: null, src: null, failed: false });
  const key = `${url}|${attempt}|${forceJpeg}`;
  // A result for an older load counts as "still loading", so nothing is reset inside the effect.
  const state = result.key === key ? result : { src: null, failed: false };

  useEffect(() => {
    let objectUrl = null;
    let cancelled = false;
    loadPhoto(url, forceJpeg)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setResult({ key, src: objectUrl, failed: false });
      })
      .catch(() => !cancelled && setResult({ key, src: null, failed: true }));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [url, attempt, forceJpeg, key]);

  if (state.failed) {
    return (
      <button
        type="button"
        onClick={() => setAttempt((n) => n + 1)}
        className={`flex flex-col items-center justify-center gap-1 bg-cream-dark font-ui text-xs text-ink-3 ${className}`}
        aria-label="Photo could not be loaded. Tap to try again"
      >
        <ImageOff size={20} aria-hidden="true" />
        <span className="flex items-center gap-1">
          <RotateCw size={12} aria-hidden="true" /> Tap to retry
        </span>
      </button>
    );
  }
  if (!state.src) {
    return (
      <div className={`flex items-center justify-center bg-cream-dark text-ink-3 ${className}`} aria-hidden="true">
        <LoaderCircle size={20} className="animate-spin" />
      </div>
    );
  }
  const img = (
    <img
      src={state.src}
      alt={alt}
      className={`object-cover ${className}`}
      onError={() => (forceJpeg ? setResult({ key, src: null, failed: true }) : setForceJpeg(true))} // got it but can't show it: try JPEG
    />
  );
  return onClick ? (
    <button type="button" onClick={() => onClick(state.src)} className="block overflow-hidden rounded-btn focus-visible:ring-2 focus-visible:ring-brand">
      {img}
    </button>
  ) : (
    img
  );
}
