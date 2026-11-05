// One look for every email ATOM sends (decided 5 Nov 2026). The look — colours, style, header, footer
// wording — comes from the Super Admin's email design (services/emailDesign.js); this file only lays it out.
// Email clients ignore <style> blocks and web fonts, so everything is inline and table-based.
// Every value is HTML-escaped. A plain-text version is always returned alongside the HTML.
const { config } = require('../config/env');
const emailDesign = require('./emailDesign');

const INSTITUTION = 'Aljamea-tus-Saifiyah';
const LOGO_PATH = '/icons/icon-192.png';
const SERIF = "Amiri, Georgia, 'Times New Roman', serif";
const SANS = 'Inter, Arial, Helvetica, sans-serif';
const MONO = "Consolas, 'Courier New', monospace";

const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#39;');

// Only http(s) links are ever put into href / src.
const safeUrl = (u) => (/^https?:\/\//i.test(String(u || '')) ? String(u) : null);

// Paragraph text: escaped, line breaks kept.
const para = (s) => esc(s).replace(/\r?\n/g, '<br>');

// {company} → the sending company; with no company (password reset) → the header title (ATOM).
const fill = (s, company, d) => String(s || '').replace(/\{company\}/gi, company || d.title).trim();

/**
 * render(content, design?)
 *   content: { company, tag, tone, title, greeting, paragraphs, details, button, note, preheader }
 *     company     sending company name, e.g. 'AVIT' (optional)
 *     tag         small label above the title, e.g. 'Resolved' (optional)
 *     tone        info | gold | success | warning | danger (tag colour)
 *     title       main heading (required)
 *     greeting    first line, e.g. 'Assalamu Alaikum Huzefa,' (optional)
 *     paragraphs  [string]
 *     details     [[label, value, { mono }]] — shown in a box; empty values skipped
 *     button      { label?, url } — http(s) only; label defaults to the design's button text
 *     note        small grey text under the button
 *     preheader   inbox preview text (hidden)
 *   design: a validated design (emailDesign.validate / current); defaults when omitted
 * → { html, text }
 */
function render(content = {}, design = emailDesign.DEFAULTS) {
  const d = emailDesign.resolve(design);
  const { c } = d;
  const {
    company = '', tag = '', tone = 'gold', title, greeting = '', paragraphs = [], details = [], button = null, note = '', preheader = '',
  } = content;
  const paras = paragraphs.filter((p) => p != null && String(p).trim() !== '');
  const rows = details.filter((r) => r && r[1] != null && String(r[1]).trim() !== '');
  const url = button && safeUrl(button.url);
  const buttonLabel = (button && button.label) || d.buttonLabel;
  const tones = {
    info: [c.primary, c.primarySoft],
    gold: [c.accentInk, c.accentSoft],
    success: ['#1E6B3A', '#E3F2E8'],
    warning: ['#8A5A00', '#FDF1D8'],
    danger: ['#9B2C2C', '#FBE7E7'],
  };
  const [tagInk, tagBg] = tones[tone] || tones.gold;
  const logo = d.showLogo ? safeUrl(`${config.appUrl}${LOGO_PATH}`) : null;
  const showCompany = d.showCompany && company;
  const signOff = fill(d.signOff, company, d);
  const footer = fill(d.footerText, company, d);
  const watermark = d.showWatermark ? fill(d.watermark, company, d) : '';
  const year = new Date().getFullYear();
  const minimal = d.style === 'minimal';
  const banner = d.style === 'banner';

  // Header colours per style.
  const headBg = minimal ? c.card : c.primary;
  const headTitle = minimal ? c.primary : '#FFFFFF';
  const headSub = minimal ? c.ink3 : c.onPrimarySoft;
  const headCompany = minimal ? c.primary : c.accent;

  const tagHtml = (onDark) => (tag
    ? `<span style="display:inline-block;padding:4px 10px;border-radius:999px;background:${onDark ? 'rgba(255,255,255,0.14)' : tagBg};font-family:${SANS};font-size:11px;font-weight:700;letter-spacing:0.8px;text-transform:uppercase;color:${onDark ? c.accent : tagInk};">${esc(tag)}</span>`
    : '');

  const brandBlock = `
            <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
              ${logo ? `<td style="vertical-align:middle;padding-right:12px;"><img src="${esc(logo)}" width="40" height="40" alt="" style="display:block;border:1px solid ${c.accent};border-radius:10px;"></td>` : ''}
              <td style="vertical-align:middle;">
                <div style="font-family:${SERIF};font-size:24px;line-height:26px;font-weight:700;color:${headTitle};letter-spacing:2px;">${esc(d.title)}</div>
                ${d.subtitle ? `<div style="font-family:${SANS};font-size:11px;line-height:15px;color:${headSub};letter-spacing:0.4px;">${esc(d.subtitle)}</div>` : ''}
              </td>
            </tr></table>`;

  const header = `
      <tr><td style="background:${headBg};padding:${banner ? '22px 32px 6px 32px' : '18px 28px'};${minimal ? `border-bottom:1px solid ${c.line};` : ''}">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="vertical-align:middle;">${brandBlock}</td>
          ${showCompany ? `<td align="right" style="vertical-align:middle;font-family:${SANS};font-size:12px;font-weight:700;letter-spacing:1.5px;color:${headCompany};text-transform:uppercase;">${esc(company)}</td>` : ''}
        </tr></table>
      </td></tr>
      ${banner ? `<tr><td style="background:${c.primary};padding:18px 32px 28px 32px;">
        ${tagHtml(true)}
        <h1 style="margin:${tag ? 12 : 0}px 0 0 0;font-family:${SERIF};font-size:28px;line-height:35px;font-weight:700;color:#FFFFFF;">${esc(title)}</h1>
      </td></tr>` : ''}
      <tr><td style="height:${minimal ? 0 : 3}px;line-height:0;font-size:0;background:${c.accent};">${minimal ? '' : '&nbsp;'}</td></tr>`;

  const titleBlock = banner ? '' : `
      <tr><td style="padding:28px 32px 4px 32px;">
        ${tagHtml(false)}
        <h1 style="margin:${tag ? 12 : 0}px 0 0 0;font-family:${SERIF};font-size:24px;line-height:31px;font-weight:700;color:${c.ink};">${esc(title)}</h1>
      </td></tr>`;

  const detailHtml = rows.length ? `
      <tr><td style="padding:12px 32px 8px 32px;">
        <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${c.background};border:1px solid ${c.line};${minimal ? `border-left:3px solid ${c.primary};` : ''}border-radius:10px;">
          ${rows.map(([label, value, opt = {}], i) => `<tr>
            <td style="padding:10px 16px;${i ? `border-top:1px solid ${c.line};` : ''}font-family:${SANS};font-size:13px;color:${c.ink3};width:38%;vertical-align:top;">${esc(label)}</td>
            <td style="padding:10px 16px;${i ? `border-top:1px solid ${c.line};` : ''}font-family:${opt.mono ? MONO : SANS};font-size:${opt.mono ? 15 : 14}px;color:${c.ink};font-weight:600;vertical-align:top;word-break:break-word;">${para(value)}</td>
          </tr>`).join('')}
        </table>
      </td></tr>` : '';

  const buttonHtml = url ? `
      <tr><td style="padding:20px 32px 4px 32px;">
        <table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
          <td style="background:${c.primary};border-radius:8px;">
            <a href="${esc(url)}" style="display:inline-block;padding:12px 26px;font-family:${SANS};font-size:15px;font-weight:600;color:#FFFFFF;text-decoration:none;border-radius:8px;">${esc(buttonLabel)} &rarr;</a>
          </td>
        </tr></table>
      </td></tr>
      <tr><td style="padding:10px 32px 0 32px;font-family:${SANS};font-size:12px;line-height:18px;color:${c.ink3};">
        Or copy this link: <a href="${esc(url)}" style="color:${c.primary};word-break:break-all;">${esc(url)}</a>
      </td></tr>` : '';

  const html = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${esc(title)}</title>
</head>
<body style="margin:0;padding:0;background:${c.background};-webkit-text-size-adjust:100%;">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent;">${esc(preheader || paras[0] || title)}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:${c.background};">
  <tr><td align="center" style="padding:24px 12px;">
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:${c.card};border:1px solid ${c.line};border-radius:14px;overflow:hidden;${minimal ? `border-top:4px solid ${c.primary};` : ''}">
      ${header}
      ${titleBlock}
      ${greeting ? `<tr><td style="padding:${banner ? 26 : 14}px 32px 0 32px;font-family:${SANS};font-size:15px;line-height:23px;color:${c.ink};">${esc(greeting)}</td></tr>` : ''}
      ${paras.map((p, i) => `<tr><td style="padding:${banner && !greeting && i === 0 ? 26 : 12}px 32px 4px 32px;font-family:${SANS};font-size:15px;line-height:23px;color:${c.ink2};">${para(p)}</td></tr>`).join('')}
      ${detailHtml}
      ${buttonHtml}
      ${note ? `<tr><td style="padding:16px 32px 0 32px;font-family:${SANS};font-size:13px;line-height:20px;color:${c.ink3};">${para(note)}</td></tr>` : ''}
      ${signOff ? `<tr><td style="padding:20px 32px 0 32px;font-family:${SANS};font-size:15px;line-height:23px;color:${c.ink};">${para(signOff)}</td></tr>` : ''}
      <tr><td style="padding:28px 32px 0 32px;"><div style="border-top:1px solid ${c.line};font-size:0;line-height:0;">&nbsp;</div></td></tr>
      <tr><td style="padding:14px 32px 24px 32px;font-family:${SANS};font-size:12px;line-height:18px;color:${c.ink3};">
        ${footer ? `<div style="font-weight:600;color:${c.ink2};">${esc(footer)}</div>` : ''}
        ${d.noReply ? `<div>${esc(d.noReply)}</div>` : ''}
      </td></tr>
    </table>
    <table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;">
      ${watermark ? `<tr><td align="center" style="padding:16px 12px 0 12px;font-family:${SERIF};font-size:13px;letter-spacing:3px;color:${c.faint};text-transform:uppercase;">
        <span style="color:${c.accent};">&#9670;</span> ${esc(watermark)} <span style="color:${c.accent};">&#9670;</span>
      </td></tr>` : ''}
      <tr><td align="center" style="padding:4px 12px 0 12px;font-family:${SANS};font-size:11px;color:${c.faint};">&copy; ${year} ${esc(INSTITUTION)}</td></tr>
    </table>
  </td></tr>
</table>
</body>
</html>`;

  const text = [
    tag ? `[${tag}]` : null,
    title,
    greeting ? `\n${greeting}` : null,
    ...paras.map((p) => `\n${p}`),
    rows.length ? `\n${rows.map(([l, v]) => `${l}: ${v}`).join('\n')}` : null,
    url ? `\n${buttonLabel}: ${url}` : null,
    note ? `\n${note}` : null,
    signOff ? `\n${signOff}` : null,
    '\n—',
    footer || null,
    d.noReply || null,
  ].filter((x) => x != null).join('\n');

  return { html, text };
}

module.exports = { render, esc, INSTITUTION };
