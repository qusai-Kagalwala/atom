// Who gets told what about a ticket (Phase 13). Rows are written INSIDE the ticket's transaction
// (so a rolled-back change never notifies anyone) and pushed over Socket.IO AFTER the commit.
//
//   created           → Super Admins · the requester when a Super Admin raised it for them
//   assigned          → the engineer · the requester · the previous engineer (re-assignment)
//   start / wait_user / wait_equipment / resume → the requester
//   resolve           → the requester · Super Admins ("ready to close")
//   close / reject    → the requester · the assigned engineer
//   Service requests (Phase 9):
//   items_decided     → the requester (how many items approved / rejected)
//   item_delivered    → the requester ("Headset delivered")
//   priority          → the requester · the engineer (new priority, time frame, the Super Admin's message)
//   overdue           → Super Admins · the engineer (once, by the background job)
// Every row is also queued as an email when email is switched on (email.js).
//   public comment    → the requester wrote it: the engineer (or Super Admins if none yet)
//                       anyone else wrote it:   the requester (+ the engineer if someone else wrote it)
//   internal note     → the engineer, when someone else wrote it. Never the requester.
// The person who caused the event is never notified. One row per person per event.
const repo = require('./notifications.repo');
const email = require('./email');
const realtime = require('../../realtime');

const ticketNumber = (t) => `${t.type === 'SERVICE_REQUEST' ? 'R' : 'T'}-${t.number}`;
const same = (a, b) => a != null && b != null && String(a) === String(b);

function short(text, max = 140) {
  const s = String(text ?? '').replace(/\s+/g, ' ').trim();
  if (!s) return null;
  return s.length > max ? `${s.slice(0, max - 1)}…` : s;
}

// Builds the recipient list for one event. Pure — exported for tests.
//   ticket: the row BEFORE the change (number, type, title, requester_id, assigned_engineer_id)
//   e:      { kind, actorId, note, engineerId, engineerName, previousEngineerId, raisedFor,
//             internal, hasPhotos, requesterReplied }
// → [{ userId | toRole, role, type, title, body }]
function planTicket(ticket, e) {
  const num = ticketNumber(ticket);
  const requester = ticket.requester_id;
  const engineer = ticket.assigned_engineer_id;
  const out = [];
  const toRequester = (title, body) => out.push({ userId: requester, role: null, title, body });
  const toEngineer = (id, title, body) => id && out.push({ userId: id, role: 'ENGINEER', title, body });
  const toAdmins = (title, body) => out.push({ toRole: 'SUPER_ADMIN', role: 'SUPER_ADMIN', title, body });

  switch (e.kind) {
    case 'created':
      toAdmins(ticket.type === 'SERVICE_REQUEST' ? `New request ${num} to approve` : `New ticket ${num}`, short(ticket.title));
      if (e.raisedFor) toRequester(`${num} was raised for you`, short(ticket.title));
      break;
    case 'assign':
      toEngineer(e.engineerId, `${num} is assigned to you`, short(ticket.title));
      toRequester(`An engineer is on ${num}`, short(`${e.engineerName || 'An engineer'} will help with: ${ticket.title}`));
      if (e.previousEngineerId && !same(e.previousEngineerId, e.engineerId)) {
        toEngineer(e.previousEngineerId, `${num} moved to another engineer`, short(ticket.title));
      }
      break;
    case 'start':
      toRequester(`Work started on ${num}`, short(ticket.title));
      break;
    case 'wait_user':
      toRequester(`${num} needs your reply`, short(e.note) || short(ticket.title));
      break;
    case 'wait_equipment':
      toRequester(`${num} is waiting for equipment`, short(e.note) || short(ticket.title));
      break;
    case 'resume':
      toRequester(`Work resumed on ${num}`, short(ticket.title));
      break;
    case 'resolve':
      if (ticket.type === 'SERVICE_REQUEST') {
        toRequester(`${num} is delivered`, short(ticket.title));
        toAdmins(`${num} delivered, ready to close`, short(ticket.title));
      } else {
        toRequester(`${num} is resolved`, short(e.note) || short(ticket.title));
        toAdmins(`${num} resolved, ready to close`, short(ticket.title));
      }
      break;
    case 'items_decided':
      toRequester(
        e.approved ? `${num}: ${e.approved} approved${e.rejected ? `, ${e.rejected} not approved` : ''}` : `${num} was not approved`,
        short(e.note) || short(ticket.title)
      );
      break;
    case 'priority': {
      const label = { HIGH: 'High', NORMAL: 'Normal', LOW: 'Low' }[e.to] || e.to;
      const body = short([e.message, e.dueText && `Now expected by ${e.dueText}.`].filter(Boolean).join(' '), 280);
      toRequester(`Priority of ${num} changed to ${label}`, body);
      toEngineer(engineer, `Priority of ${num} changed to ${label}`, body);
      break;
    }
    case 'overdue':
      toAdmins(`${num} is overdue`, short(ticket.title));
      toEngineer(engineer, `${num} is overdue`, short(ticket.title));
      break;
    case 'item_delivered':
      toRequester(`${num}: ${short(e.itemName, 60)} delivered`, short(e.note));
      break;
    case 'close':
      toRequester(`${num} is closed`, short(ticket.title));
      toEngineer(engineer, `${num} was closed`, short(ticket.title));
      break;
    case 'reject':
      toRequester(`${num} was rejected`, short(e.note));
      toEngineer(engineer, `${num} was rejected`, short(e.note));
      break;
    case 'comment': {
      const body = short(e.note) || (e.hasPhotos ? 'Added a photo.' : null);
      // A Super Admin who raised it for someone counts as "anyone else", so the requester hears about it.
      const byRequesterSide = same(e.actorId, requester);
      if (e.internal) {
        if (!same(e.actorId, engineer)) toEngineer(engineer, `Internal note on ${num}`, body);
      } else if (byRequesterSide) {
        const title = e.requesterReplied ? `Requester replied on ${num}` : `New comment on ${num}`;
        if (engineer) toEngineer(engineer, title, body);
        else toAdmins(`New comment on ${num}`, body);
      } else {
        toRequester(`New comment on ${num}`, body);
        if (!same(e.actorId, engineer)) toEngineer(engineer, `New comment on ${num}`, body);
      }
      break;
    }
    default:
      break;
  }

  // Never notify the actor; one row per person (first rule wins).
  const seen = new Set();
  return out.filter((n) => {
    if (n.toRole) return true;
    if (n.userId == null || same(n.userId, e.actorId) || seen.has(String(n.userId))) return false;
    seen.add(String(n.userId));
    return true;
  });
}

// Inside the ticket transaction. → inserted rows (hand them to publish() after COMMIT).
async function recordTicketEvent(db, ticket, e) {
  const link = `/tickets/${ticketNumber(ticket)}`;
  const type = `ticket.${e.kind}`;
  const rows = [];
  for (const n of planTicket(ticket, e)) {
    const base = { type, title: n.title, body: n.body, link, requestId: ticket.id, actorId: e.actorId };
    if (n.toRole) rows.push(...(await repo.insertForRole(db, { ...base, role: n.toRole })));
    else {
      const row = await repo.insertForUser(db, { ...base, userId: n.userId, role: n.role });
      if (row) rows.push(row);
    }
  }
  await email.queueForRows(db, rows, ticket);
  return rows;
}

function toPublic(row) {
  return {
    id: String(row.id),
    type: row.type,
    title: row.title,
    body: row.body,
    link: row.link,
    role: row.role,
    read: Boolean(row.read_at),
    createdAt: row.created_at,
  };
}

// After COMMIT: push each new row to its recipient, then tell everyone involved that the ticket
// changed so open lists and sidebar counts refresh. Never throws (the change is already saved).
function publish(rows, ticket, extraUserIds = []) {
  try {
    for (const row of rows) {
      const payload = toPublic(row);
      if (row.role) realtime.emitToUserRole(row.user_id, row.role, 'notification:new', payload);
      else realtime.emitToUser(row.user_id, 'notification:new', payload);
    }
    if (ticket) {
      const changed = { number: ticketNumber(ticket) };
      realtime.emitToRole('SUPER_ADMIN', 'requests:changed', changed);
      const ids = new Set(
        [ticket.requester_id, ticket.raised_by_id, ticket.assigned_engineer_id, ...extraUserIds]
          .filter((id) => id != null)
          .map(String)
      );
      for (const id of ids) realtime.emitToUser(id, 'requests:changed', changed);
    }
  } catch (err) {
    console.error('Notification push failed:', err.message);
  }
}

// ---------- API (the signed-in user's own notifications, active role only) ----------
async function list(user, opts) {
  const { rows, total, unread } = await repo.list(user, opts);
  return { notifications: rows.map(toPublic), total, unread };
}

const unreadCount = async (user) => ({ unread: await repo.unreadCount(user) });

async function markRead(user, id) {
  const ok = await repo.markRead(user, id);
  return ok ? { unread: await repo.unreadCount(user) } : null;
}

async function markAllRead(user) {
  await repo.markAllRead(user);
  return { unread: 0 };
}

module.exports = { planTicket, recordTicketEvent, publish, toPublic, ticketNumber, list, unreadCount, markRead, markAllRead };
