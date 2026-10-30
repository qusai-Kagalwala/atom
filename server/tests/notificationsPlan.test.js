// Phase 13: who gets told what about a ticket (pure rules, no DB).
const { planTicket, publish } = require('../modules/notifications/notifications.service');
const realtime = require('../realtime');

const REQ = '10';
const ENG = '20';
const ENG2 = '21';
const ADMIN = '30';

const ticket = (over = {}) => ({
  id: '1',
  number: 1001,
  type: 'TICKET',
  title: 'Projector not working',
  requester_id: REQ,
  raised_by_id: REQ,
  assigned_engineer_id: ENG,
  service_unit_id: '1',
  ...over,
});

// Compact view: "who:role title"
const who = (list) =>
  list.map((n) => `${n.toRole ? `all:${n.toRole}` : `${n.userId}:${n.role ?? 'any'}`} ${n.title}`);

describe('planTicket', () => {
  test('created → all Super Admins; raised-for → also the requester', () => {
    expect(who(planTicket(ticket({ assigned_engineer_id: null }), { kind: 'created', actorId: REQ }))).toEqual([
      'all:ADMIN New ticket T-1001',
    ]);
    const forSomeone = ticket({ assigned_engineer_id: null, raised_by_id: ADMIN });
    expect(who(planTicket(forSomeone, { kind: 'created', actorId: ADMIN, raisedFor: true }))).toEqual([
      'all:ADMIN New ticket T-1001',
      '10:any T-1001 was raised for you',
    ]);
  });

  test('assign → engineer (Engineer role) + requester; re-assign also tells the previous engineer', () => {
    const t = ticket({ assigned_engineer_id: null });
    expect(who(planTicket(t, { kind: 'assign', actorId: ADMIN, engineerId: ENG, engineerName: 'Taher' }))).toEqual([
      '20:ENGINEER T-1001 is assigned to you',
      '10:any An engineer is on T-1001',
    ]);
    const plan = planTicket(ticket(), { kind: 'assign', actorId: ADMIN, engineerId: ENG2, engineerName: 'Murtaza', previousEngineerId: ENG });
    expect(who(plan)).toEqual([
      '21:ENGINEER T-1001 is assigned to you',
      '10:any An engineer is on T-1001',
      '20:ENGINEER T-1001 moved to someone else',
    ]);
    expect(plan[1].body).toBe('Murtaza will help with: Projector not working');
  });

  test('assign with an occupation: "A carpenter is on …", the full name with the occupation in the body', () => {
    const plan = planTicket(ticket({ assigned_engineer_id: null }), {
      kind: 'assign', actorId: null, engineerId: ENG, engineerName: 'Abbas Test Carpenter', occupation: 'Carpenter',
    });
    expect(who(plan)).toEqual(['20:ENGINEER T-1001 is assigned to you', '10:any A carpenter is on T-1001']);
    expect(plan[1].body).toBe('Carpenter: Abbas Test Carpenter will help with: Projector not working');
    const ac = planTicket(ticket(), { kind: 'assign', actorId: ADMIN, engineerId: ENG2, engineerName: 'X Y', occupation: 'AC Technician' });
    expect(ac[1].title).toBe('An AC technician is on T-1001');
  });

  test('created + auto-assigned: the Admins hear who got it', () => {
    const plan = planTicket(ticket({ assigned_engineer_id: null }), { kind: 'created', actorId: REQ, autoAssignedTo: 'Carpenter: Abbas Test Carpenter' });
    expect(plan[0]).toMatchObject({ title: 'New ticket T-1001', body: 'Projector not working · assigned automatically to Carpenter: Abbas Test Carpenter' });
  });

  test('engineer status changes tell the requester; the note is the body when given', () => {
    expect(who(planTicket(ticket(), { kind: 'start', actorId: ENG }))).toEqual(['10:any Work started on T-1001']);
    const wait = planTicket(ticket(), { kind: 'wait_user', actorId: ENG, note: 'Which room is it in?' });
    expect(who(wait)).toEqual(['10:any T-1001 needs your reply']);
    expect(wait[0].body).toBe('Which room is it in?');
    expect(who(planTicket(ticket(), { kind: 'wait_equipment', actorId: ENG }))).toEqual(['10:any T-1001 is waiting for equipment']);
    expect(who(planTicket(ticket(), { kind: 'resume', actorId: ENG }))).toEqual(['10:any Work resumed on T-1001']);
  });

  test('resolve → requester + Super Admins (ready to close)', () => {
    expect(who(planTicket(ticket(), { kind: 'resolve', actorId: ENG, note: 'Replaced the HDMI cable' }))).toEqual([
      '10:any T-1001 is resolved',
      'all:ADMIN T-1001 resolved, ready to close',
    ]);
  });

  test('close / reject → requester + assigned engineer; reject without an engineer → requester only', () => {
    expect(who(planTicket(ticket(), { kind: 'close', actorId: ADMIN }))).toEqual([
      '10:any T-1001 is closed',
      '20:ENGINEER T-1001 was closed',
    ]);
    expect(who(planTicket(ticket({ assigned_engineer_id: null }), { kind: 'reject', actorId: ADMIN, note: 'Duplicate of T-1000' }))).toEqual([
      '10:any T-1001 was rejected',
    ]);
  });

  test('public comment by the requester → engineer, or Super Admins when no engineer yet', () => {
    expect(who(planTicket(ticket(), { kind: 'comment', actorId: REQ, note: 'Room 12' }))).toEqual([
      '20:ENGINEER New comment on T-1001',
    ]);
    expect(who(planTicket(ticket(), { kind: 'comment', actorId: REQ, note: 'Room 12', requesterReplied: true }))).toEqual([
      '20:ENGINEER Requester replied on T-1001',
    ]);
    expect(who(planTicket(ticket({ assigned_engineer_id: null }), { kind: 'comment', actorId: REQ, note: 'Any update?' }))).toEqual([
      'all:ADMIN New comment on T-1001',
    ]);
  });

  test('public comment by the engineer → requester; by a Super Admin → requester + engineer', () => {
    expect(who(planTicket(ticket(), { kind: 'comment', actorId: ENG, note: 'On my way' }))).toEqual([
      '10:any New comment on T-1001',
    ]);
    expect(who(planTicket(ticket({ raised_by_id: ADMIN }), { kind: 'comment', actorId: ADMIN, note: 'FYI' }))).toEqual([
      '10:any New comment on T-1001',
      '20:ENGINEER New comment on T-1001',
    ]);
  });

  test('internal notes never reach the requester', () => {
    expect(who(planTicket(ticket(), { kind: 'comment', actorId: ADMIN, note: 'Check warranty', internal: true }))).toEqual([
      '20:ENGINEER Internal note on T-1001',
    ]);
    expect(planTicket(ticket(), { kind: 'comment', actorId: ENG, note: 'Note to self', internal: true })).toEqual([]);
  });

  test('photo-only comment has a body; long text is shortened', () => {
    expect(planTicket(ticket(), { kind: 'comment', actorId: ENG, hasPhotos: true })[0].body).toBe('Added a photo.');
    const body = planTicket(ticket(), { kind: 'comment', actorId: ENG, note: 'x'.repeat(500) })[0].body;
    expect(body).toHaveLength(140);
    expect(body.endsWith('…')).toBe(true);
  });

  test('the actor is never notified, and one person gets one row per event', () => {
    // Engineer raised a ticket for themself and is assigned to it: the Super Admin who assigns
    // tells them once (as engineer), not twice.
    const own = ticket({ requester_id: ENG, raised_by_id: ENG, assigned_engineer_id: null });
    expect(who(planTicket(own, { kind: 'assign', actorId: ADMIN, engineerId: ENG }))).toEqual([
      '20:ENGINEER T-1001 is assigned to you',
    ]);
    // An engineer working on their own ticket isn't told about their own action.
    expect(planTicket(ticket({ requester_id: ENG }), { kind: 'start', actorId: ENG })).toEqual([]);
  });

  test('service requests use the R- prefix', () => {
    expect(who(planTicket(ticket({ type: 'SERVICE_REQUEST' }), { kind: 'start', actorId: ENG }))).toEqual([
      '10:any Work started on R-1001',
    ]);
  });
});

describe('publish', () => {
  afterEach(() => realtime._setIo(null));

  test('role rows go to user:<id>:<role>, own-ticket rows to user:<id>; everyone involved gets requests:changed', () => {
    const sent = [];
    realtime._setIo({ to: (room) => ({ emit: (event, payload) => sent.push([room, event, payload]) }) });
    const now = new Date('2026-10-24T10:00:00Z');
    publish(
      [
        { id: 1, user_id: '20', role: 'ENGINEER', type: 'ticket.assign', title: 'T-1001 is assigned to you', body: null, link: '/tickets/T-1001', read_at: null, created_at: now },
        { id: 2, user_id: '10', role: null, type: 'ticket.assign', title: 'An engineer is on T-1001', body: 'x', link: '/tickets/T-1001', read_at: null, created_at: now },
      ],
      ticket({ assigned_engineer_id: null }),
      ['20']
    );
    expect(sent.map(([room, event]) => `${room} ${event}`)).toEqual([
      'user:20:ENGINEER notification:new',
      'user:10 notification:new',
      'co:1:admins requests:changed',
      'user:10 requests:changed',
      'user:20 requests:changed',
    ]);
    expect(sent[0][2]).toEqual({
      id: '1', type: 'ticket.assign', title: 'T-1001 is assigned to you', body: null,
      link: '/tickets/T-1001', role: 'ENGINEER', company: null, read: false, createdAt: now,
    });
  });

  test('never throws (the change is already saved)', () => {
    realtime._setIo({ to: () => { throw new Error('boom'); } });
    jest.spyOn(console, 'error').mockImplementation(() => {});
    expect(() => publish([], ticket())).not.toThrow();
    jest.restoreAllMocks();
  });

  test('no io attached (tests, sync script) → silent no-op', () => {
    expect(() => publish([{ id: 1, user_id: '1', role: null, created_at: new Date() }], ticket())).not.toThrow();
  });
});
