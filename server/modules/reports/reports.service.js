// PDF reports (Phase 15, decided 2 Nov 2026). Built on the server with pdfmake (MIT) and the Roboto
// font that ships with it — nothing is fetched from the network or the disk outside that folder.
// Every report is for the active company and carries: company, title, period and filters, who made it
// and when, page numbers. The client shows it first (preview) and downloads the same file.
const path = require('path');
const pdfmake = require('pdfmake');
const pool = require('../../db/pool');
const { config } = require('../../config/env');
const { HttpError, notFound } = require('../../utils/httpError');
const analytics = require('./analytics.service');
const onboarding = require('../inventory/onboarding.service');
const { ASSET_SELECT } = require('../inventory/inventory.service');

const bad = (message, code) => new HttpError(400, message, code);
const isId = (v) => /^\d{1,18}$/.test(String(v ?? ''));
const MAX_ROWS = 3000;

const FONT_DIR = path.join(path.dirname(require.resolve('pdfmake/package.json')), 'fonts', 'Roboto');
pdfmake.setFonts({
  Roboto: {
    normal: path.join(FONT_DIR, 'Roboto-Regular.ttf'),
    bold: path.join(FONT_DIR, 'Roboto-Medium.ttf'),
    italics: path.join(FONT_DIR, 'Roboto-Italic.ttf'),
    bolditalics: path.join(FONT_DIR, 'Roboto-MediumItalic.ttf'),
  },
});
pdfmake.setLocalAccessPolicy((p) => path.resolve(p).startsWith(FONT_DIR));
pdfmake.setUrlAccessPolicy(() => false);

const TEAL = '#0F5B5A';
const GOLD = '#C9A84C';
const INK2 = '#5B5B5B';
const LINE = '#E0D6C8';

const STATUS = {
  PENDING_APPROVAL: 'Waiting for approval', OPEN: 'Open', ASSIGNED: 'Assigned', IN_PROGRESS: 'In progress',
  WAITING_FOR_USER: 'Waiting for requester', WAITING_FOR_EQUIPMENT: 'Waiting for equipment', RESOLVED: 'Resolved', CLOSED: 'Closed', REJECTED: 'Rejected',
};
const PRIORITY = { HIGH: 'High', NORMAL: 'Normal', LOW: 'Low' };
const ASSET_STATUS = { IN_STORE: 'In store', IN_USE: 'In use', IN_REPAIR: 'In repair', RETIRED: 'Retired' };

const fmtDate = (v) =>
  v ? new Intl.DateTimeFormat('en-GB', { timeZone: config.timeZone, day: '2-digit', month: 'short', year: 'numeric' }).format(new Date(v)) : '—';
const fmtDateTime = (v) =>
  v
    ? new Intl.DateTimeFormat('en-GB', { timeZone: config.timeZone, day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(v))
    : '—';
const fmtDay = (d) => fmtDate(`${d}T12:00:00Z`);
function duration(min) {
  if (min == null) return '—';
  if (min < 60) return `${min} min`;
  const h = Math.floor(min / 60);
  if (h < 48) return `${h} h ${min % 60} min`;
  return `${Math.floor(h / 24)} d ${h % 24} h`;
}
const pctText = (v) => (v == null ? '—' : `${v}%`);
const num = (t) => (t.type === 'SERVICE_REQUEST' ? `R-${t.number}` : `T-${t.number}`);

// ---------- layout ----------
function table(headers, rows, widths) {
  return {
    table: {
      headerRows: 1,
      widths: widths || headers.map(() => '*'),
      body: [headers.map((h) => ({ text: h, bold: true, color: '#FFFFFF', fillColor: TEAL })), ...rows.map((r) => r.map((c) => (c == null ? '—' : c)))],
    },
    layout: {
      hLineColor: () => LINE,
      vLineColor: () => LINE,
      fillColor: (i) => (i > 0 && i % 2 === 0 ? '#FAF7F2' : null),
      paddingTop: () => 3,
      paddingBottom: () => 3,
    },
    fontSize: 8,
    margin: [0, 4, 0, 10],
  };
}
const h2 = (text) => ({ text, fontSize: 12, bold: true, color: TEAL, margin: [0, 8, 0, 2] });
const kv = (pairs) => ({
  columns: pairs.map(([label, value]) => ({
    stack: [{ text: label.toUpperCase(), fontSize: 7, color: INK2 }, { text: String(value), fontSize: 14, bold: true, color: '#3B2A1A' }],
  })),
  columnGap: 8,
  margin: [0, 4, 0, 8],
});

function doc({ title, company, user, period, filters = [], content, landscape = false }) {
  const meta = [period ? `Period: ${fmtDay(period.from)} – ${fmtDay(period.to)}` : null, ...filters].filter(Boolean).join(' · ');
  return {
    pageSize: 'A4',
    pageOrientation: landscape ? 'landscape' : 'portrait',
    pageMargins: [36, 72, 36, 44],
    info: { title: `ATOM — ${title}`, author: 'ATOM', subject: company?.name || '' },
    defaultStyle: { font: 'Roboto', fontSize: 9, color: '#1A1A1A' },
    header: () => ({
      margin: [36, 22, 36, 0],
      stack: [
        {
          columns: [
            { text: [{ text: 'ATOM', bold: true, color: TEAL, fontSize: 14 }, { text: `  ·  ${company?.name || ''}`, color: INK2, fontSize: 10 }] },
            { text: 'Aljamea-tus-Saifiyah', alignment: 'right', color: GOLD, fontSize: 8, margin: [0, 4, 0, 0] },
          ],
        },
        { canvas: [{ type: 'line', x1: 0, y1: 6, x2: landscape ? 770 : 523, y2: 6, lineWidth: 1, lineColor: GOLD }] },
      ],
    }),
    footer: (page, pages) => ({
      margin: [36, 12, 36, 0],
      columns: [
        { text: `Made by ${user.name || 'ATOM'} on ${fmtDateTime(new Date())}`, fontSize: 7, color: INK2 },
        { text: `Page ${page} of ${pages}`, alignment: 'right', fontSize: 7, color: INK2 },
      ],
    }),
    content: [
      { text: title, fontSize: 18, bold: true, color: '#3B2A1A' },
      meta ? { text: meta, fontSize: 8, color: INK2, margin: [0, 2, 0, 8] } : { text: '', margin: [0, 0, 0, 6] },
      ...content,
    ],
  };
}

// ---------- data helpers ----------
async function categoryName(user, id) {
  if (!id) return null;
  if (!isId(id)) throw bad('Bad category.', 'bad_filter');
  const { rows } = await pool.query('SELECT name FROM categories WHERE id = $1::bigint AND service_unit_id = $2::bigint', [id, user.companyId]);
  if (!rows[0]) throw bad('Choose a category of this company.', 'bad_filter');
  return rows[0].name;
}
async function staffName(user, id) {
  if (!id) return null;
  if (!isId(id)) throw bad('Bad staff member.', 'bad_filter');
  const { rows } = await pool.query(
    `SELECT COALESCE(u.name, 'Employee ' || u.employee_id) AS name FROM users u JOIN user_company uc ON uc.user_id = u.id
      WHERE u.id = $1::bigint AND uc.service_unit_id = $2::bigint`,
    [id, user.companyId]
  );
  if (!rows[0]) throw bad('Choose a staff member of this company.', 'bad_filter');
  return rows[0].name;
}
const STATE = { open: `NOT IN ('RESOLVED','CLOSED','REJECTED')`, closed: `IN ('RESOLVED','CLOSED','REJECTED')` };

// ---------- the reports ----------
async function ticketsReport(user, q) {
  const p = analytics.period(q);
  const state = ['open', 'closed'].includes(q.status) ? q.status : 'all';
  const cat = await categoryName(user, q.categoryId);
  const staff = await staffName(user, q.engineerId);
  const params = [user.companyId, p.from, p.to, config.timeZone];
  const where = [`r.service_unit_id = $1::bigint`, `r.type = 'TICKET'`,
    `r.created_at >= ($2::date::timestamp AT TIME ZONE $4::text)`, `r.created_at < (($3::date + 1)::timestamp AT TIME ZONE $4::text)`];
  if (state !== 'all') where.push(`r.status ${STATE[state]}`);
  if (cat) where.push(`r.category_id = $${params.push(q.categoryId)}::bigint`);
  if (staff) where.push(`r.assigned_engineer_id = $${params.push(q.engineerId)}::bigint`);
  const { rows } = await pool.query(
    `SELECT r.number, r.type, r.title, r.status, r.priority, r.created_at, r.resolved_at, r.due_by, c.name AS category,
            COALESCE(rq.name, 'Employee ' || rq.employee_id) AS requester, COALESCE(e.name, 'Employee ' || e.employee_id) AS engineer, o.name AS occupation,
            COALESCE((SELECT d.name FROM user_posts up JOIN departments d ON d.id = up.department_id WHERE up.user_id = r.requester_id AND up.is_active ORDER BY up.id LIMIT 1),
                     (SELECT d.name FROM user_departments ud JOIN departments d ON d.id = ud.department_id WHERE ud.user_id = r.requester_id AND ud.is_active ORDER BY ud.id LIMIT 1)) AS department
       FROM requests r
       LEFT JOIN categories c ON c.id = r.category_id
       JOIN users rq ON rq.id = r.requester_id
       LEFT JOIN users e ON e.id = r.assigned_engineer_id
       LEFT JOIN user_company uc ON uc.user_id = e.id
       LEFT JOIN occupations o ON o.id = uc.occupation_id
      WHERE ${where.join(' AND ')}
      ORDER BY r.created_at, r.number LIMIT ${MAX_ROWS + 1}`,
    params
  );
  const counts = {};
  for (const r of rows) counts[r.status] = (counts[r.status] || 0) + 1;
  return doc({
    title: 'Tickets raised',
    company: user.company,
    user,
    period: p,
    landscape: true,
    filters: [state !== 'all' ? (state === 'open' ? 'Open only' : 'Done / rejected only') : null, cat && `Category: ${cat}`, staff && `Staff: ${staff}`],
    content: [
      kv([['Tickets', Math.min(rows.length, MAX_ROWS)], ...Object.entries(counts).slice(0, 5).map(([s, n]) => [STATUS[s] || s, n])]),
      rows.length > MAX_ROWS ? { text: `Only the first ${MAX_ROWS} are listed — choose a shorter period.`, color: '#8B2A2A', fontSize: 8 } : '',
      rows.length
        ? table(
            ['No.', 'Raised', 'Title', 'Category', 'Department', 'Requester', 'Assigned to', 'Priority', 'Status', 'Resolved'],
            rows.slice(0, MAX_ROWS).map((r) => [num(r), fmtDate(r.created_at), r.title, r.category, r.department, r.requester,
              r.engineer ? `${r.occupation ? `${r.occupation}: ` : ''}${r.engineer}` : null, PRIORITY[r.priority] || r.priority,
              STATUS[r.status] || r.status, r.resolved_at ? fmtDate(r.resolved_at) : null]),
            [32, 50, '*', 60, 70, 70, 80, 38, 55, 50]
          )
        : { text: 'No tickets in this period.', color: INK2 },
    ],
  });
}

async function performanceReport(user, q) {
  const p = analytics.period(q);
  const a = await analytics.companyAnalytics(user, q);
  const h = a.headline;
  return doc({
    title: 'Performance',
    company: user.company,
    user,
    period: p,
    content: [
      kv([['Raised', h.raised], ['Done', h.done], ['Rejected', h.rejected], ['Still open', h.stillOpen]]),
      kv([['Success rate', pctText(h.successRate)], ['Within time frame', pctText(h.withinTimeFrame)], ['Overdue now', h.overdueNow]]),
      kv([['Avg first response', duration(h.avgResponseMinutes)], ['Avg resolution', duration(h.avgResolutionMinutes)]]),
      { text: 'Success rate = (resolved + closed) ÷ (resolved + closed + rejected). Within time frame = resolved before the end of its expected window.', fontSize: 7, color: INK2 },
      h2('By category'),
      a.byCategory.length ? table(['Category', 'Tickets'], a.byCategory.map((c) => [c.label, c.count]), ['*', 60]) : { text: 'None.', color: INK2 },
      h2('By priority'),
      a.byPriority.length ? table(['Priority', 'Tickets'], a.byPriority.map((c) => [PRIORITY[c.key] || c.key, c.count]), ['*', 60]) : { text: 'None.', color: INK2 },
      h2('Top departments'),
      a.byDepartment.length ? table(['Department', 'Tickets'], a.byDepartment.map((c) => [c.label, c.count]), ['*', 60]) : { text: 'None.', color: INK2 },
    ],
  });
}

const workloadTable = (staff) =>
  staff.length
    ? table(
        ['Staff member', 'Occupation', 'Open now', 'Assigned', 'Done', 'Avg resolution', 'Within time frame'],
        staff.map((s) => [s.name, s.occupation, s.openNow, s.assigned, s.done, duration(s.avgResolutionMinutes), pctText(s.withinTimeFrame)]),
        ['*', 80, 45, 45, 40, 70, 70]
      )
    : { text: 'No staff in this company yet.', color: INK2 };

async function workloadReport(user, q) {
  const p = analytics.period(q);
  const staff = await analytics.staffWorkload(user.companyId, p);
  return doc({
    title: 'Staff workload',
    company: user.company,
    user,
    period: p,
    filters: ['Assigned / done count tickets raised in the period; open now is today'],
    content: [workloadTable(staff)],
  });
}

async function assetsReport(user, q) {
  const status = ['IN_STORE', 'IN_USE', 'IN_REPAIR', 'RETIRED', 'all'].includes(q.assetStatus) ? q.assetStatus : 'active';
  const params = [user.companyId];
  const where = ['a.service_unit_id = $1::bigint'];
  if (status === 'active') where.push(`a.status <> 'RETIRED'`);
  else if (status !== 'all') where.push(`a.status = $${params.push(status)}::asset_status`);
  let catName = null;
  if (q.assetCategoryId) {
    if (!isId(q.assetCategoryId)) throw bad('Bad category.', 'bad_filter');
    const { rows } = await pool.query('SELECT name FROM asset_categories WHERE id = $1::bigint AND service_unit_id = $2::bigint', [q.assetCategoryId, user.companyId]);
    if (!rows[0]) throw bad('Choose a category of this company.', 'bad_filter');
    catName = rows[0].name;
    where.push(`a.category_id = $${params.push(q.assetCategoryId)}::bigint`);
  }
  const { rows } = await pool.query(`${ASSET_SELECT} WHERE ${where.join(' AND ')} ORDER BY c.name, a.asset_tag LIMIT ${MAX_ROWS + 1}`, params);
  const by = {};
  for (const a of rows) by[a.status] = (by[a.status] || 0) + 1;
  return doc({
    title: 'Asset list',
    company: user.company,
    user,
    landscape: true,
    filters: [status === 'active' ? 'Not retired' : status === 'all' ? 'All statuses' : ASSET_STATUS[status], catName && `Category: ${catName}`, `As of ${fmtDate(new Date())}`],
    content: [
      kv([['Assets', Math.min(rows.length, MAX_ROWS)], ...Object.entries(by).map(([s, n]) => [ASSET_STATUS[s] || s, n])]),
      rows.length
        ? table(
            ['Tag', 'Name / model', 'Category', 'Serial', 'Status', 'Place', 'Held by'],
            rows.slice(0, MAX_ROWS).map((a) => [a.asset_tag, a.name || [a.manufacturer, a.model].filter(Boolean).join(' ') || null, a.category_name, a.serial,
              ASSET_STATUS[a.status] || a.status, a.place?.name || null, a.holder?.name || (a.holder_unknown ? 'Unknown' : null)]),
            [55, '*', 80, 80, 50, 100, 100]
          )
        : { text: 'No assets.', color: INK2 },
    ],
  });
}

async function personAssetsReport(user, q) {
  if (!isId(q.personId)) throw bad('Choose a person.', 'bad_filter');
  const { person, assets } = await onboarding.personEquipment(user, q.personId);
  return doc({
    title: `Assets held by ${person.name}`,
    company: user.company,
    user,
    filters: [[person.itsNumber && `ITS ${person.itsNumber}`, person.employeeId && `Employee ID ${person.employeeId}`].filter(Boolean).join(' · '),
      person.isActive ? null : 'Inactive', `As of ${fmtDate(new Date())}`],
    content: [
      kv([['Assets held', assets.length], ['To recover', assets.filter((a) => a.toRecoverSince).length]]),
      assets.length
        ? table(['Tag', 'Name / model', 'Category', 'Serial', 'Status', 'Note'],
            assets.map((a) => [a.tag, a.name || [a.manufacturer, a.model].filter(Boolean).join(' ') || null, a.category.name, a.serial,
              ASSET_STATUS[a.status] || a.status, a.toRecoverSince ? 'To recover' : null]),
            [55, '*', 80, 80, 50, 55])
        : { text: 'Holds nothing from this company.', color: INK2 },
      { text: '\n\nReceived by: ______________________          Signature: ______________________          Date: ____________', fontSize: 9 },
    ],
  });
}

async function invoicesReport(user, q) {
  const p = analytics.period(q);
  const { rows } = await pool.query(
    `SELECT i.number, i.invoice_date, i.created_at, i.supplier, i.reference, i.note, COALESCE(u.name, 'Employee ' || u.employee_id) AS uploaded_by,
            COALESCE((SELECT string_agg(CASE r.type WHEN 'SERVICE_REQUEST' THEN 'R-' ELSE 'T-' END || r.number, ', ' ORDER BY r.number)
                        FROM invoice_links l JOIN requests r ON r.id = l.request_id WHERE l.invoice_id = i.id AND l.unlinked_at IS NULL), '') AS linked
       FROM invoices i JOIN users u ON u.id = i.uploaded_by_id
      WHERE i.service_unit_id = $1::bigint
        AND COALESCE(i.invoice_date::timestamp AT TIME ZONE $4::text, i.created_at) >= ($2::date::timestamp AT TIME ZONE $4::text)
        AND COALESCE(i.invoice_date::timestamp AT TIME ZONE $4::text, i.created_at) < (($3::date + 1)::timestamp AT TIME ZONE $4::text)
      ORDER BY COALESCE(i.invoice_date, i.created_at::date), i.number LIMIT ${MAX_ROWS}`,
    [user.companyId, p.from, p.to, config.timeZone]
  );
  return doc({
    title: 'Invoices with linked tickets',
    company: user.company,
    user,
    period: p,
    filters: ['By invoice date (upload date when there is none)'],
    landscape: true,
    content: [
      kv([['Invoices', rows.length], ['Not linked to a ticket', rows.filter((r) => !r.linked).length]]),
      rows.length
        ? table(['Invoice', 'Date', 'Supplier', 'Reference', 'Linked tickets / requests', 'Uploaded by', 'Note'],
            rows.map((r) => [`INV-${r.number}`, fmtDate(r.invoice_date || r.created_at), r.supplier, r.reference, r.linked || 'Not linked', r.uploaded_by, r.note]),
            [50, 55, 100, 80, '*', 90, 120])
        : { text: 'No invoices in this period.', color: INK2 },
    ],
  });
}

async function monthlyReport(user, q) {
  const month = q.month ? String(q.month) : analytics.today().slice(0, 7);
  if (!/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) throw bad('Choose the month as YYYY-MM.', 'bad_period');
  const from = `${month}-01`;
  const next = new Date(`${from}T00:00:00Z`);
  next.setUTCMonth(next.getUTCMonth() + 1);
  const to = analytics.addDays(next.toISOString().slice(0, 10), -1);
  const a = await analytics.companyAnalytics(user, { from, to });
  const h = a.headline;
  const name = new Intl.DateTimeFormat('en-GB', { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(new Date(`${from}T00:00:00Z`));
  return doc({
    title: `Monthly summary — ${name}`,
    company: user.company,
    user,
    period: a.period,
    content: [
      kv([['Tickets raised', h.raised], ['Done', h.done], ['Rejected', h.rejected], ['Still open', h.stillOpen]]),
      kv([['Success rate', pctText(h.successRate)], ['Within time frame', pctText(h.withinTimeFrame)], ['Avg first response', duration(h.avgResponseMinutes)], ['Avg resolution', duration(h.avgResolutionMinutes)]]),
      kv([['Service requests', a.serviceRequests.requests], ['Items delivered', a.serviceRequests.delivered], ['AI chats', a.assistant.chats], ['Solved by AI', pctText(a.assistant.solvedRate)]]),
      h2('Top categories'),
      a.byCategory.length ? table(['Category', 'Tickets'], a.byCategory.slice(0, 8).map((c) => [c.label, c.count]), ['*', 60]) : { text: 'None.', color: INK2 },
      h2('Top departments'),
      a.byDepartment.length ? table(['Department', 'Tickets'], a.byDepartment.slice(0, 8).map((c) => [c.label, c.count]), ['*', 60]) : { text: 'None.', color: INK2 },
      h2('Staff workload'),
      workloadTable(a.staff),
    ],
  });
}

const REPORTS = {
  tickets: { title: 'Tickets raised', build: ticketsReport },
  performance: { title: 'Performance', build: performanceReport },
  workload: { title: 'Staff workload', build: workloadReport },
  assets: { title: 'Asset list', build: assetsReport },
  person: { title: 'Assets held by one person', build: personAssetsReport },
  invoices: { title: 'Invoices with linked tickets', build: invoicesReport },
  monthly: { title: 'Monthly summary', build: monthlyReport },
};

// → { buffer, filename } for the active company.
async function render(user, type, q = {}) {
  const r = REPORTS[type];
  if (!r) throw notFound();
  const definition = await r.build(user, q);
  const buffer = await pdfmake.createPdf(definition).getBuffer();
  const stamp = analytics.today();
  const filename = `ATOM-${(user.company?.code || 'ATOM').toLowerCase()}-${type}-${stamp}.pdf`;
  return { buffer: Buffer.from(buffer), filename };
}

module.exports = { render, REPORTS, duration };
