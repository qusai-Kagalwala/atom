import { CircleHelp } from 'lucide-react';
import { Link } from 'react-router-dom';

export default function NotFoundPage() {
  return (
    <section className="card mx-auto max-w-md text-center">
      <CircleHelp size={24} className="mx-auto text-primary" aria-hidden="true" />
      <h1 className="mt-3 text-2xl">Page not found</h1>
      <p className="mt-2 font-ui text-sm text-ink-2">The page you opened does not exist.</p>
      <Link to="/" className="btn-primary mt-5">
        Go to home
      </Link>
    </section>
  );
}
