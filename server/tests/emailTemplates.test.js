// Editable email wording (7 Nov 2026): Settings → Email design → Ticket / Service request / Jamea Internet
// Access / Password reset. Subject, greeting (several lines), intro, closing, with {placeholders}.
const templates = require('../services/emailTemplates');
const design = require('../services/emailDesign');
const notificationEmail = require('../modules/notifications/email');
const { resetEmail } = require('../modules/auth/passwords.service');

const withTemplates = (t) => design.validate({ templates: t });

describe('fill', () => {
  test('placeholders filled; an empty name drops its line and the space before the comma', () => {
    expect(templates.fill('Assalamu Alaikum {name},', { name: 'Huzefa' })).toBe('Assalamu Alaikum Huzefa,');
    expect(templates.fill('Assalamu Alaikum {name},', {})).toBe('Assalamu Alaikum,');
    expect(templates.fill('Salaam-e-Jameel\n{name}', {})).toBe('Salaam-e-Jameel');
    expect(templates.fill('Salaam-e-Jameel\n{name},', { name: 'Huzefa' })).toBe('Salaam-e-Jameel\nHuzefa,');
  });
});

describe('validate', () => {
  test('defaults reproduce the old wording; missing templates fall back', () => {
    const d = design.validate({});
    expect(d.templates.wifi.greeting).toBe('Assalamu Alaikum {name},');
    expect(d.templates.reset.subject).toBe('Reset your ATOM password');
    expect(withTemplates({ wifi: { greeting: 'Salaam' } }).templates.wifi.intro).toBe(templates.DEFAULTS.wifi.intro);
  });

  test('unknown placeholder, too long, too many lines, empty subject → 400 with the field', () => {
    const fail = (t) => {
      try {
        withTemplates(t);
      } catch (e) {
        return { status: e.status, field: e.field, message: e.message };
      }
      return null;
    };
    expect(fail({ reset: { intro: 'Hi {ssid}' } })).toMatchObject({ status: 400, field: 'templates.reset.intro' });
    expect(fail({ reset: { intro: 'Hi {ssid}' } }).message).toMatch(/\{name\}, \{minutes\}/);
    expect(fail({ ticket: { subject: '' } })).toMatchObject({ field: 'templates.ticket.subject' });
    expect(fail({ ticket: { greeting: 'a\nb\nc\nd\ne' } })).toMatchObject({ field: 'templates.ticket.greeting' });
    expect(fail({ ticket: { closing: 'x'.repeat(601) } })).toMatchObject({ field: 'templates.ticket.closing' });
    expect(fail({ ticket: 'nope' })).toMatchObject({ field: 'templates.ticket' });
  });

  test('line breaks kept (one empty line at most); subject made one line', () => {
    const d = withTemplates({ ticket: { subject: 'A\nB', greeting: 'Salaam-e-Jameel\n\n\n\n{name}' } });
    expect(d.templates.ticket.subject).toBe('A B');
    expect(d.templates.ticket.greeting).toBe('Salaam-e-Jameel\n\n{name}');
  });
});

describe('the emails use it', () => {
  test('ticket notification: subject, two-line greeting with the recipient name, intro before, closing after', () => {
    const d = withTemplates({ ticket: { subject: '{number}: {title}', greeting: 'Salaam-e-Jameel\n{name}', intro: 'An update from {company}:', closing: 'Shukran' } });
    const mail = notificationEmail.render(
      { type: 'ticket.resolve', title: 'T-1001 resolved', body: 'Projector fixed', link: '/tickets/T-1001' },
      { number: 1001, type: 'INCIDENT', status: 'RESOLVED' },
      d,
      'AVIT',
      'Huzefa'
    );
    expect(mail.subject).toBe('T-1001: T-1001 resolved');
    expect(mail.text).toMatch(/Salaam-e-Jameel\nHuzefa\n\nAn update from AVIT:\n\nProjector fixed/);
    expect(mail.text).toContain('Shukran');
    expect(mail.html).toContain('Salaam-e-Jameel<br>Huzefa');
  });

  test('service request uses its own template; defaults keep the old subject', () => {
    const d = withTemplates({ request: { subject: 'Request {number}' } });
    const row = { type: 'ticket.items_decided', title: 'R-204 approved', body: 'ok' };
    expect(notificationEmail.render(row, { number: 204, type: 'SERVICE_REQUEST', status: 'APPROVED' }, d).subject).toBe('Request R-204');
    expect(notificationEmail.render(row, { number: 5, type: 'INCIDENT', status: 'OPEN' }, d).subject).toBe('ATOM: R-204 approved');
  });

  test('password reset: {minutes} and the name', () => {
    const d = withTemplates({ reset: { greeting: 'Dear {name}', intro: 'Use it within {minutes} minutes.' } });
    const mail = resetEmail('https://example.edu/reset', d, 'Huzefa');
    expect(mail.text).toContain('Dear Huzefa');
    expect(mail.text).toMatch(/Use it within \d+ minutes\./);
    expect(mail.subject).toBe('Reset your ATOM password');
  });
});
