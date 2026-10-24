import { Construction } from 'lucide-react';
import { Link } from 'react-router-dom';

// Placeholder for nav items whose phase hasn't been built yet. `action` = { to, label } for a useful next step.
export default function ComingSoonPage({ title = 'Coming soon', text = 'This part of ATOM is not ready yet.', action }) {
  return (
    <section className="card mx-auto max-w-md text-center">
      <Construction size={24} className="mx-auto text-gold-dark" aria-hidden="true" />
      <h1 className="mt-3 text-2xl">{title}</h1>
      <p className="mt-2 font-ui text-sm text-ink-2">{text}</p>
      <div className="mt-5 flex flex-wrap justify-center gap-2">
        {action && (
          <Link to={action.to} className="btn-primary">
            {action.label}
          </Link>
        )}
        <Link to="/" className={action ? 'btn-secondary' : 'btn-primary'}>
          Go to home
        </Link>
      </div>
    </section>
  );
}
