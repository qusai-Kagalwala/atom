import { useEffect, useState } from 'react';
import { Download, ExternalLink, FileText, ImageOff, LoaderCircle } from 'lucide-react';
import { fetchInvoiceFile } from '../api/invoices';

// Preview + download of a protected invoice file (fetched with the login token as a blob).
// Images show inline; PDFs show in a frame on larger screens (phones: Open / Download).
export default function InvoiceFile({ invoice }) {
  const [state, setState] = useState({ url: null, failed: false });

  useEffect(() => {
    let objectUrl = null;
    let cancelled = false;
    fetchInvoiceFile(invoice.fileUrl)
      .then((blob) => {
        if (cancelled) return;
        objectUrl = URL.createObjectURL(blob);
        setState({ url: objectUrl, failed: false });
      })
      .catch(() => !cancelled && setState({ url: null, failed: true }));
    return () => {
      cancelled = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [invoice.fileUrl]);

  const isPdf = invoice.fileType === 'pdf';
  const downloadName = `${invoice.number}.${isPdf ? 'pdf' : 'webp'}`;

  if (state.failed) {
    return (
      <div className="flex items-center gap-2 rounded-btn bg-cream-dark p-4 font-ui text-sm text-ink-2" role="status">
        <ImageOff size={18} aria-hidden="true" /> The file could not be loaded.
      </div>
    );
  }
  if (!state.url) {
    return (
      <p className="flex items-center gap-2 font-ui text-sm text-ink-2">
        <LoaderCircle size={18} className="animate-spin" aria-hidden="true" /> Loading the file…
      </p>
    );
  }

  return (
    <div className="space-y-3">
      {isPdf ? (
        <>
          <iframe title={`${invoice.number} PDF`} src={state.url} className="hidden h-[70vh] w-full rounded-btn border border-line sm:block" />
          <div className="flex items-center gap-2 rounded-btn bg-cream-dark p-4 font-ui text-sm text-ink-2 sm:hidden">
            <FileText size={18} aria-hidden="true" /> PDF invoice: open or download it below.
          </div>
        </>
      ) : (
        <img src={state.url} alt={`Invoice ${invoice.number}`} className="mx-auto max-h-[70vh] w-auto rounded-btn border border-line" />
      )}
      <div className="flex flex-wrap gap-2">
        <a href={state.url} target="_blank" rel="noopener noreferrer" className="btn-secondary">
          <ExternalLink size={18} aria-hidden="true" /> Open in new tab
        </a>
        <a href={state.url} download={downloadName} className="btn-secondary">
          <Download size={18} aria-hidden="true" /> Download
        </a>
      </div>
    </div>
  );
}
