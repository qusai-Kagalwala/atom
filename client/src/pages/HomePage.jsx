import { Link } from 'react-router-dom';
import { ArrowRight, Bot, ShoppingCart, Ticket } from 'lucide-react';
import useAuth from '../hooks/useAuth';

// Same three cards for every role — Super Admins and Engineers raise tickets too.
const CARDS = [
  {
    to: '/assistant',
    Icon: Bot,
    title: 'Talk to the AI assistant',
    text: "Something isn't working? Get an answer first; raise a ticket if it doesn't help.",
  },
  {
    to: '/request',
    Icon: ShoppingCart,
    title: 'Request a service or asset',
    text: 'New equipment, software, a subscription or a licence.',
  },
  {
    to: '/track',
    Icon: Ticket,
    title: 'Track tickets & requests',
    text: "See the status of everything you've raised and the equipment assigned to you.",
  },
];

export default function HomePage() {
  const { user } = useAuth();
  const firstName = String(user.name || '').split(/\s+/)[0];

  return (
    <section>
      <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">Home</p>
      <h1 className="mt-1 text-3xl">{firstName ? `Welcome, ${firstName}` : 'Welcome'}</h1>
      <p className="mt-2 font-ui text-sm text-ink-2">What do you need help with today?</p>

      <ul className="mt-6 grid gap-4 md:grid-cols-3">
        {CARDS.map(({ to, Icon, title, text }) => (
          <li key={to}>
            <Link
              to={to}
              className="card group flex h-full flex-col transition-shadow hover:border-gold hover:shadow-glow-gold focus-visible:shadow-glow-gold"
            >
              <span className="flex h-12 w-12 items-center justify-center rounded-card bg-primary-tint text-primary">
                <Icon size={24} aria-hidden="true" />
              </span>
              <h2 className="mt-4 text-xl">{title}</h2>
              <p className="mt-1 flex-1 font-ui text-sm text-ink-2">{text}</p>
              <span className="mt-4 inline-flex items-center gap-1 font-ui text-sm font-medium text-primary">
                Open <ArrowRight size={16} aria-hidden="true" className="transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
