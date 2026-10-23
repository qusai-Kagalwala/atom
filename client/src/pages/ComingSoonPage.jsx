import { Construction } from 'lucide-react';
import { Link } from 'react-router-dom';

// Placeholder for nav items whose phase hasn't been built yet.
export default function ComingSoonPage({ title = 'Coming soon' }) {
  return (
    <section className="card mx-auto max-w-md text-center">
      <Construction size={24} className="mx-auto text-gold-dark" aria-hidden="true" />
      <h1 className="mt-3 text-2xl">{title}</h1>
      <p className="mt-2 font-ui text-sm text-ink-2">This part of ATOM is not ready yet.</p>
      <Link to="/" className="btn-primary mt-5">
        Go to home
      </Link>
    </section>
  );
}
