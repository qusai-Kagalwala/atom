// Styled emails: escaping, plain-text copy, links, notification mapping.
const { render } = require('../services/emailLayout');
const email = require('../modules/notifications/email');
const { config } = require('../config/env');

describe('email layout', () => {
  test('escapes every value and keeps a plain-text copy', () => {
    const { html, text } = render({
      company: 'AVIT',
      tag: 'New',
      title: 'T-1 <script>alert(1)</script>',
      paragraphs: ['Line one\nLine "two" & more'],
      details: [['Ticket', 'T-1'], ['Empty', ''], ['Expected by', null]],
      button: { label: 'Open in ATOM', url: 'https://example.edu/Atom/tickets/T-1' },
    });
    expect(html).not.toContain('<script>');
    expect(html).toContain('T-1 &lt;script&gt;alert(1)&lt;/script&gt;');
    expect(html).toContain('Line one<br>Line &quot;two&quot; &amp; more');
    expect(html).toContain('href="https://example.edu/Atom/tickets/T-1"');
    expect(html).not.toContain('>Empty<');
    expect(text).toContain('Ticket: T-1');
    expect(text).not.toContain('Empty:');
    expect(text).toContain('Open in ATOM: https://example.edu/Atom/tickets/T-1');
    expect(text).toContain('Aljamea-tus-Saifiyah');
  });

  test('never links a non-http URL', () => {
    const { html, text } = render({ title: 'x', button: { label: 'Go', url: 'javascript:alert(1)' } });
    expect(html).not.toContain('javascript:');
    expect(text).not.toContain('javascript:');
  });

  test('notification email: tag, reference, expected-by, button', () => {
    const row = { type: 'ticket.resolve', title: 'T-1001 resolved, ready to close', body: 'Acrobat – not genuine', link: '/tickets/T-1001' };
    const ticket = { number: 1001, type: 'INCIDENT', status: 'IN_PROGRESS', due_by: '2026-11-05T11:23:00Z', service_unit_name: 'AVIT' };
    const { html, text } = email.render(row, ticket);
    expect(html).toContain('Resolved');
    expect(html).toContain('AVIT');
    expect(text).toContain('Ticket: T-1001');
    expect(text).toMatch(/Expected by: 5 Nov, 4:53\s?pm/i);
    expect(text).toContain(`${config.appUrl}/tickets/T-1001`);
    expect(email.compose(row, ticket)).toBe(text);
  });

  test('service request resolved reads "Delivered"; final tickets have no expected-by', () => {
    const row = { type: 'ticket.resolve', title: 'R-5 delivered', link: '/tickets/R-5' };
    const { html, text } = email.render(row, { number: 5, type: 'SERVICE_REQUEST', status: 'CLOSED', due_by: new Date() });
    expect(html).toContain('Delivered');
    expect(text).toContain('Request: R-5');
    expect(text).not.toContain('Expected by');
  });
});

describe('email design checks', () => {
  const emailDesign = require('../services/emailDesign');
  const { render: layout } = require('../services/emailLayout');

  test('palettes set the colours; custom colours are checked', () => {
    expect(emailDesign.validate({ palette: 'maroon' }).colors.primary).toBe('#721634');
    expect(() => emailDesign.validate({ palette: 'pink' })).toThrow(/colour set/);
    const ok = emailDesign.validate({ palette: 'custom', colors: { primary: '#123456', accent: '#C9A84C', background: '#fafafa', text: '#111111' } });
    expect(ok.colors).toEqual({ primary: '#123456', accent: '#C9A84C', background: '#FAFAFA', text: '#111111' });
    expect(() => emailDesign.validate({ palette: 'custom', colors: { primary: '#123456', accent: '#C9A84C', background: '#333333', text: '#FFFFFF' } })).toThrow(/light shade/);
    expect(() => emailDesign.validate({ palette: 'custom', colors: { primary: '#123456', accent: '#C9A84C', background: '#FFFFFF', text: '#BBBBBB' } })).toThrow(/hard to read/);
  });

  test('text limits, line breaks squashed, flags must be true/false', () => {
    expect(emailDesign.validate({ subtitle: ' a\n\nb ' }).subtitle).toBe('a b');
    expect(() => emailDesign.validate({ title: 'x'.repeat(21) })).toThrow(/up to 20/);
    expect(() => emailDesign.validate({ showLogo: 'yes' })).toThrow();
    expect(() => emailDesign.validate(null)).toThrow();
  });

  test('{company} fills in; with no company it becomes the title; switches hide parts', () => {
    const d = emailDesign.validate({ signOff: 'Regards, {company} Team', showWatermark: false, showLogo: false, noReply: '' });
    const withCo = layout({ company: 'Siyanaat', title: 'x' }, d);
    expect(withCo.text).toContain('Regards, Siyanaat Team');
    expect(withCo.text).toContain('Siyanaat · Aljamea-tus-Saifiyah');
    expect(withCo.html).not.toContain('<img');
    expect(withCo.html).not.toContain('&#9670;');
    expect(withCo.text).not.toContain('automatic message');
    expect(layout({ title: 'x' }, d).text).toContain('Regards, ATOM Team');
  });

  test('every style renders the title once in the body', () => {
    for (const style of emailDesign.STYLES) {
      const { html } = layout({ title: 'Unique Title 42', tag: 'New' }, emailDesign.validate({ style }));
      expect(html.match(/<h1/g)).toHaveLength(1);
      expect(html).toContain('Unique Title 42');
    }
  });
});
