import { Link } from 'react-router-dom';
import { ArrowRight, Bot, ShoppingCart, Ticket, TriangleAlert } from 'lucide-react';
import UserName from '../components/UserName';
import useAuth from '../hooks/useAuth';

// Same three cards for every role — Admins and Staff raise tickets too. Each company has its own AI
// assistant (step C); when the Super Admin switches it off, the first card raises a ticket directly.
const RAISE = {
  to: '/tickets/new',
  Icon: TriangleAlert,
  title: 'Report a problem',
  text: 'Something broken or not working? Raise a ticket and the right person is sent.',
};
const CARDS = [
  {
    to: '/assistant',
    Icon: Bot,
    title: 'Talk to the AI assistant',
    text: "Something isn't working or you need something? Get an answer first; raise a ticket if it doesn't help.",
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
  const cards = user.company?.assistantEnabled !== false ? CARDS : [RAISE, ...CARDS.slice(1)];

  return (
    <section>
      <p className="font-ui text-xs uppercase tracking-wider text-gold-dark">{user.company?.name || 'Home'}</p>
      <h1 className="mt-1 text-3xl">
        Welcome, <UserName user={user} />
      </h1>
      <p className="mt-2 font-ui text-sm text-ink-2">What do you need help with today?</p>

      {/* The two things people come for, one tap away. */}
      <div className="mt-4 grid grid-cols-1 gap-2 sm:flex sm:flex-wrap">
        <Link to="/tickets/new" className="btn-primary justify-center">
          <TriangleAlert size={18} aria-hidden="true" /> Raise a ticket
        </Link>
        <Link to="/request" className="btn-secondary justify-center">
          <ShoppingCart size={18} aria-hidden="true" /> Request something
        </Link>
      </div>

      <ul className="mt-6 grid grid-cols-1 gap-4 md:grid-cols-3">
        {cards.map(({ to, Icon, title, text }, i) => (
          <li key={to} className="anim-rise" style={{ '--i': i + 1 }}>
            <Link
              to={to}
              className="card group flex h-full flex-col transition-[box-shadow,transform,border-color] hover:-translate-y-0.5 hover:border-gold hover:shadow-glow-gold focus-visible:shadow-glow-gold"
            >
              <span className="flex h-12 w-12 items-center justify-center rounded-card bg-primary-tint text-brand">
                <Icon size={24} aria-hidden="true" />
              </span>
              <h2 className="mt-4 text-xl">{title}</h2>
              <p className="mt-1 flex-1 font-ui text-sm text-ink-2">{text}</p>
              <span className="mt-4 inline-flex items-center gap-1 font-ui text-sm font-medium text-brand">
                Open <ArrowRight size={16} aria-hidden="true" className="transition-transform group-hover:translate-x-0.5" />
              </span>
            </Link>
          </li>
        ))}
      </ul>
    </section>
  );
}
