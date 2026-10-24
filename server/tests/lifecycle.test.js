// Ticket lifecycle rules — every action × status × role. Pure, no DB.
const lc = require('../modules/requests/lifecycle');

const STATUSES = ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_FOR_USER', 'WAITING_FOR_EQUIPMENT', 'RESOLVED', 'CLOSED', 'REJECTED'];

const ticket = (status, extra = {}) => ({ status, requester_id: '1', raised_by_id: '1', assigned_engineer_id: status === 'OPEN' ? null : '2', ...extra });
const admin = { id: '9', activeRole: 'SUPER_ADMIN' };
const engineer = { id: '2', activeRole: 'ENGINEER' }; // assigned
const otherEngineer = { id: '3', activeRole: 'ENGINEER' };
const requester = { id: '1', activeRole: 'EMPLOYEE' };
const assignedButAsEmployee = { id: '2', activeRole: 'EMPLOYEE' };

// Expected actions per status for the Super Admin and for the assigned engineer.
const ADMIN = {
  OPEN: ['assign', 'reject'],
  ASSIGNED: ['assign', 'start', 'reject'],
  IN_PROGRESS: ['assign', 'wait_user', 'wait_equipment', 'resolve', 'reject'],
  WAITING_FOR_USER: ['assign', 'wait_equipment', 'resume', 'resolve', 'reject'],
  WAITING_FOR_EQUIPMENT: ['assign', 'wait_user', 'resume', 'resolve', 'reject'],
  RESOLVED: ['close', 'reject'],
  CLOSED: [],
  REJECTED: [],
};
const ENGINEER = {
  OPEN: [],
  ASSIGNED: ['start'],
  IN_PROGRESS: ['wait_user', 'wait_equipment', 'resolve'],
  WAITING_FOR_USER: ['wait_equipment', 'resume', 'resolve'],
  WAITING_FOR_EQUIPMENT: ['wait_user', 'resume', 'resolve'],
  RESOLVED: [],
  CLOSED: [],
  REJECTED: [],
};

describe.each(STATUSES)('status %s', (status) => {
  const t = ticket(status);

  test('Super Admin', () => expect(lc.allowedActions(admin, t)).toEqual(ADMIN[status]));
  test('assigned Engineer', () => expect(lc.allowedActions(engineer, t)).toEqual(ENGINEER[status]));
  test('another Engineer: nothing', () => expect(lc.allowedActions(otherEngineer, t)).toEqual([]));
  test('requester: nothing', () => expect(lc.allowedActions(requester, t)).toEqual([]));
  test('assigned engineer acting as Employee: nothing', () => expect(lc.allowedActions(assignedButAsEmployee, t)).toEqual([]));

  test('comments only before final', () => {
    expect(lc.canComment(requester, t)).toBe(!['CLOSED', 'REJECTED'].includes(status));
  });
});

describe('assertAllowed', () => {
  it('returns the rule when allowed', () => {
    expect(lc.assertAllowed(admin, ticket('RESOLVED'), 'close')).toMatchObject({ to: 'CLOSED' });
  });
  it('409 when the right person acts on the wrong stage', () => {
    expect(() => lc.assertAllowed(admin, ticket('CLOSED'), 'reject')).toThrow(expect.objectContaining({ status: 409 }));
    expect(() => lc.assertAllowed(engineer, ticket('RESOLVED'), 'resolve')).toThrow(expect.objectContaining({ status: 409 }));
  });
  it('404 when the role cannot act at all', () => {
    expect(() => lc.assertAllowed(requester, ticket('RESOLVED'), 'close')).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => lc.assertAllowed(engineer, ticket('RESOLVED'), 'close')).toThrow(expect.objectContaining({ status: 404 }));
    expect(() => lc.assertAllowed(otherEngineer, ticket('IN_PROGRESS'), 'resolve')).toThrow(expect.objectContaining({ status: 404 }));
  });
  it('400 for an unknown action', () => {
    expect(() => lc.assertAllowed(admin, ticket('OPEN'), 'reopen')).toThrow(expect.objectContaining({ status: 400 }));
  });
  it('resolve and reject require a note', () => {
    expect(lc.ACTIONS.resolve.noteRequired).toBeTruthy();
    expect(lc.ACTIONS.reject.noteRequired).toBeTruthy();
    expect(lc.ACTIONS.close.noteRequired).toBeFalsy();
  });
});

describe('nextStatus', () => {
  it('assign moves OPEN to ASSIGNED and keeps any later status (reassign)', () => {
    expect(lc.nextStatus('assign', 'OPEN')).toBe('ASSIGNED');
    expect(lc.nextStatus('assign', 'IN_PROGRESS')).toBe('IN_PROGRESS');
  });
  it.each([
    ['start', 'IN_PROGRESS'], ['wait_user', 'WAITING_FOR_USER'], ['wait_equipment', 'WAITING_FOR_EQUIPMENT'],
    ['resume', 'IN_PROGRESS'], ['resolve', 'RESOLVED'], ['close', 'CLOSED'], ['reject', 'REJECTED'],
  ])('%s → %s', (action, to) => expect(lc.nextStatus(action, 'X')).toBe(to));
});

describe('visibility', () => {
  it('internal notes: Super Admin and the assigned engineer only', () => {
    const t = ticket('IN_PROGRESS');
    expect(lc.canSeeInternal(admin, t)).toBe(true);
    expect(lc.canSeeInternal(engineer, t)).toBe(true);
    expect(lc.canSeeInternal(otherEngineer, t)).toBe(false);
    expect(lc.canSeeInternal(requester, t)).toBe(false);
    expect(lc.canSeeInternal(assignedButAsEmployee, t)).toBe(false);
  });
  it('triage (priority / category): Super Admin until final', () => {
    expect(lc.canEditTriage(admin, ticket('RESOLVED'))).toBe(true);
    expect(lc.canEditTriage(admin, ticket('CLOSED'))).toBe(false);
    expect(lc.canEditTriage(engineer, ticket('IN_PROGRESS'))).toBe(false);
  });
});
