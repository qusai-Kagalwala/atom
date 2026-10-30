// FAQ bank management (Phase 12; per company since step C, 30 Oct 2026 — each company's Admin
// manages its own FAQs, another company's FAQ = 404).
//   - Import the FAQ JSON (re-runnable; matched on item_id). Preview first; the same steps run and
//     are rolled back. FAQs changed in ATOM are kept unless "keep ATOM changes" is off.
//   - Add / edit / switch off FAQs in all four languages. Never deleted.
const pool = require('../../db/pool');
const { HttpError, notFound } = require('../../utils/httpError');
const { LANGS, normaliseFaq, hashFaq, parseFaqFile, ticketCategoryName } = require('./faqData');
const assistant = require('./assistant.service');

const bad = (message, code) => new HttpError(400, message, code);
const isId = (v) => /^\d{1,18}$/.test(String(v ?? ''));
const LOCK_KEY = 727307; // FAQ import / edits
const ATOM_ITEM_START = 100000;

async function inTransaction(fn) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await fn(client);
    await client.query('COMMIT');
    return result;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    throw err;
  } finally {
    client.release();
  }
}

const SELECT = `
  SELECT f.*, c.name AS ticket_category_name, p.name AS problem_name, i.id AS problem_item_id, i.name AS problem_item_name
    FROM faqs f LEFT JOIN categories c ON c.id = f.ticket_category_id
    LEFT JOIN ticket_problems p ON p.id = f.ticket_problem_id
    LEFT JOIN ticket_items i ON i.id = p.item_id`;

function toFaq(r, { detail = false } = {}) {
  const base = {
    id: String(r.id),
    itemId: r.item_id,
    category: r.category,
    item: r.item,
    subItem: r.sub_item,
    question: r.answers?.en?.question || '',
    languages: LANGS.filter((l) => r.answers?.[l]?.question),
    directTicket: r.direct_ticket,
    ticketCategory: r.ticket_category_id ? { id: String(r.ticket_category_id), name: r.ticket_category_name } : null,
    // The problem of the company's problem list this FAQ answers (browse buttons, ticket item / problem).
    problem: r.ticket_problem_id
      ? { id: String(r.ticket_problem_id), itemId: String(r.problem_item_id), item: r.problem_item_name, name: r.problem_name }
      : null,
    source: r.source,
    editedInAtom: Boolean(r.edited_in_atom_at),
    isActive: r.is_active,
    updatedAt: r.updated_at,
  };
  if (!detail) return base;
  return { ...base, keywords: r.keywords, answers: r.answers, detailsEn: r.details_en, ticketInfo: r.ticket_info };
}

async function categoryIds(db, companyId) {
  const { rows } = await db.query(
    `SELECT c.id, c.name, s.code FROM categories c JOIN service_units s ON s.id = c.service_unit_id
      WHERE c.service_unit_id = $1::bigint AND c.is_active`,
    [companyId]
  );
  const ids = new Map(rows.map((r) => [r.name.toLowerCase(), String(r.id)]));
  ids.code = rows[0]?.code || null;
  return ids;
}
// Ticket category for an FAQ: AVIT maps by item / FAQ category (faqData); other companies use their
// category of the same name as the FAQ's category. Else "Other".
const mappedCategory = (ids, f) =>
  (ids.code === 'AVIT' ? ids.get(ticketCategoryName(f.category, f.item).toLowerCase()) : ids.get(String(f.category).toLowerCase())) ||
  ids.get('other') ||
  null;

// FAQs with no problem link get the company's problem of the same item and name (if there is one).
async function autoLinkProblems(db, companyId) {
  await db.query(
    `UPDATE faqs f SET ticket_problem_id = m.problem_id
       FROM (
         SELECT DISTINCT ON (f2.id) f2.id AS faq_id, p.id AS problem_id
           FROM faqs f2
           JOIN ticket_items i ON i.service_unit_id = f2.service_unit_id AND lower(trim(i.name)) = lower(trim(f2.item))
           JOIN ticket_problems p ON p.item_id = i.id
            AND lower(trim(regexp_replace(p.name, '\\s*\\(specify in description\\)\\s*', '', 'i')))
              = lower(trim(regexp_replace(f2.sub_item, '\\s*\\(specify in description\\)\\s*', '', 'i')))
          WHERE f2.service_unit_id = $1::bigint AND f2.ticket_problem_id IS NULL
          ORDER BY f2.id, p.is_active DESC, i.is_active DESC, p.id
       ) m
      WHERE f.id = m.faq_id`,
    [companyId]
  );
}

async function validProblem(db, companyId, id) {
  if (id == null || id === '') return null;
  if (!isId(id)) throw bad('Choose a problem of this company.', 'bad_problem');
  const { rows } = await db.query('SELECT id FROM ticket_problems WHERE id = $1::bigint AND service_unit_id = $2::bigint', [id, companyId]);
  if (!rows[0]) throw bad('Choose a problem of this company.', 'bad_problem');
  return String(id);
}

// ---------- read ----------
async function listFaqs(user, { includeInactive = false } = {}) {
  const { rows } = await pool.query(
    `${SELECT} WHERE f.service_unit_id = $1::bigint ${includeInactive ? '' : 'AND f.is_active'} ORDER BY f.category, f.item, f.item_id`,
    [user.companyId]
  );
  return rows.map((r) => toFaq(r));
}

async function getFaq(user, id) {
  if (!isId(id)) throw notFound();
  const { rows } = await pool.query(`${SELECT} WHERE f.id = $1::bigint AND f.service_unit_id = $2::bigint`, [id, user.companyId]);
  if (!rows[0]) throw notFound();
  return toFaq(rows[0], { detail: true });
}

// ---------- add / edit ----------
async function validTicketCategory(db, companyId, id) {
  if (id == null || id === '') return null;
  if (!isId(id)) throw bad('Choose a ticket category.', 'bad_category');
  const ids = await categoryIds(db, companyId);
  if (![...ids.values()].includes(String(id))) throw bad('Choose a ticket category.', 'bad_category');
  return String(id);
}

async function createFaq(user, body = {}) {
  const f = normaliseFaq(body);
  if (f.error) throw bad(f.error, 'invalid');
  const co = user.companyId;
  const row = await inTransaction(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock($1::bigint)', [LOCK_KEY]);
    const catId = body.ticketCategoryId != null && body.ticketCategoryId !== ''
      ? await validTicketCategory(db, co, body.ticketCategoryId)
      : mappedCategory(await categoryIds(db, co), f);
    const problemId = await validProblem(db, co, body.ticketProblemId);
    const { rows: m } = await db.query(
      'SELECT COALESCE(max(item_id), $1::int - 1) + 1 AS next FROM faqs WHERE item_id >= $1::int AND service_unit_id = $2::bigint',
      [ATOM_ITEM_START, co]
    );
    const { rows } = await db.query(
      `INSERT INTO faqs (service_unit_id, item_id, category, item, sub_item, keywords, direct_ticket, answers, details_en, ticket_info,
                         ticket_category_id, ticket_problem_id, source)
       VALUES ($11::bigint, $1::int, $2::text, $3::text, $4::text, $5::text[], $6::boolean, $7::jsonb, $8::jsonb, $9::jsonb, $10::bigint,
               $12::bigint, 'atom')
       RETURNING id`,
      [m[0].next, f.category, f.item, f.subItem, f.keywords, f.directTicket, JSON.stringify(f.answers),
        JSON.stringify(f.detailsEn), JSON.stringify(f.ticketInfo), catId, co, problemId]
    );
    if (!problemId && !('ticketProblemId' in body)) await autoLinkProblems(db, co);
    return rows[0];
  });
  assistant.bust(co);
  return getFaq(user, row.id);
}

async function updateFaq(user, id, body = {}) {
  if (!isId(id)) throw notFound();
  const co = user.companyId;
  await inTransaction(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock($1::bigint)', [LOCK_KEY]);
    const { rows } = await db.query('SELECT * FROM faqs WHERE id = $1::bigint AND service_unit_id = $2::bigint FOR UPDATE', [id, co]);
    const cur = rows[0];
    if (!cur) throw notFound();
    const merged = {
      category: body.category ?? cur.category,
      item: body.item ?? cur.item,
      subItem: body.subItem ?? cur.sub_item,
      keywords: body.keywords ?? cur.keywords,
      directTicket: body.directTicket ?? cur.direct_ticket,
      answers: body.answers ?? cur.answers,
      detailsEn: body.detailsEn ?? cur.details_en,
      ticketInfo: body.ticketInfo ?? cur.ticket_info,
    };
    const f = normaliseFaq(merged);
    if (f.error) throw bad(f.error, 'invalid');
    const catId = 'ticketCategoryId' in body ? await validTicketCategory(db, co, body.ticketCategoryId) : cur.ticket_category_id;
    const problemId = 'ticketProblemId' in body ? await validProblem(db, co, body.ticketProblemId) : cur.ticket_problem_id;
    if ('isActive' in body && typeof body.isActive !== 'boolean') throw bad('Bad status value.', 'invalid');
    const isActive = 'isActive' in body ? body.isActive : cur.is_active;
    await db.query(
      `UPDATE faqs SET category = $2::text, item = $3::text, sub_item = $4::text, keywords = $5::text[],
              direct_ticket = $6::boolean, answers = $7::jsonb, details_en = $8::jsonb, ticket_info = $9::jsonb,
              ticket_category_id = $10::bigint, is_active = $11::boolean, ticket_problem_id = $12::bigint,
              edited_in_atom_at = CASE WHEN source = 'json' THEN now() ELSE edited_in_atom_at END
        WHERE id = $1::bigint`,
      [id, f.category, f.item, f.subItem, f.keywords, f.directTicket, JSON.stringify(f.answers),
        JSON.stringify(f.detailsEn), JSON.stringify(f.ticketInfo), catId, isActive, problemId]
    );
  });
  assistant.bust(co);
  return getFaq(user, id);
}

// ---------- JSON import ----------
class Rollback extends Error {}

// Into the active company. The languages / screen texts in the file are shared by every company's
// assistant: they are saved from AVIT's file (or from the first file when none are saved yet).
async function importFaqFile(user, buf, { commit = false, keepAtomEdits = true } = {}) {
  const co = user.companyId;
  const parsed = parseFaqFile(buf.toString('utf8'));
  if (parsed.fatal) throw bad(parsed.fatal, 'bad_file');
  if (!parsed.faqs.length) throw bad('The file has no usable FAQs.', 'empty_file');

  const report = {
    committed: false,
    inFile: parsed.faqs.length + parsed.errors.length,
    created: 0,
    updated: 0,
    unchanged: 0,
    keptAtomEdits: [],
    errors: parsed.errors,
    notInFile: [],
    languages: parsed.content.languages.map((l) => l.code),
  };

  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock($1::bigint)', [LOCK_KEY]);
    const ids = await categoryIds(client, co);
    const { rows: existing } = await client.query('SELECT * FROM faqs WHERE service_unit_id = $1::bigint', [co]);
    const byItem = new Map(existing.map((r) => [r.item_id, r]));

    for (const f of parsed.faqs) {
      const cur = byItem.get(f.itemId);
      const values = [f.category, f.item, f.subItem, f.keywords, f.directTicket, JSON.stringify(f.answers),
        JSON.stringify(f.detailsEn), JSON.stringify(f.ticketInfo), f.hash];
      if (!cur) {
        await client.query(
          `INSERT INTO faqs (item_id, category, item, sub_item, keywords, direct_ticket, answers, details_en, ticket_info,
                             content_hash, ticket_category_id, service_unit_id, source)
           VALUES ($1::int, $2::text, $3::text, $4::text, $5::text[], $6::boolean, $7::jsonb, $8::jsonb, $9::jsonb,
                   $10::text, $11::bigint, $12::bigint, 'json')`,
          [f.itemId, ...values, mappedCategory(ids, f), co]
        );
        report.created += 1;
        continue;
      }
      if (cur.source === 'json' && cur.content_hash === f.hash && !cur.edited_in_atom_at) {
        report.unchanged += 1;
        continue;
      }
      if (cur.edited_in_atom_at && keepAtomEdits) {
        report.keptAtomEdits.push({ itemId: f.itemId, item: cur.item, subItem: cur.sub_item });
        continue;
      }
      if (cur.source === 'atom' && keepAtomEdits) {
        report.keptAtomEdits.push({ itemId: f.itemId, item: cur.item, subItem: cur.sub_item });
        continue;
      }
      await client.query(
        `UPDATE faqs SET category = $2::text, item = $3::text, sub_item = $4::text, keywords = $5::text[],
                direct_ticket = $6::boolean, answers = $7::jsonb, details_en = $8::jsonb, ticket_info = $9::jsonb,
                content_hash = $10::text, ticket_category_id = $11::bigint, source = 'json',
                edited_in_atom_at = NULL, is_active = TRUE
          WHERE id = $1::bigint`,
        [cur.id, ...values, mappedCategory(ids, f)]
      );
      report.updated += 1;
    }

    const inFile = new Set(parsed.faqs.map((f) => f.itemId));
    report.notInFile = existing
      .filter((r) => r.source === 'json' && r.is_active && !inFile.has(r.item_id))
      .map((r) => ({ itemId: r.item_id, item: r.item, subItem: r.sub_item }));

    await autoLinkProblems(client, co);
    if (ids.code === 'AVIT' || !(await client.query(`SELECT 1 FROM assistant_settings WHERE id = 1 AND content ? 'languages'`)).rows[0]) {
      await client.query(
        `INSERT INTO assistant_settings (id, content) VALUES (1, $1::jsonb) ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content`,
        [JSON.stringify(parsed.content)]
      );
    }

    if (!commit) throw new Rollback();
    await client.query('COMMIT');
    report.committed = true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (!(err instanceof Rollback)) throw err;
  } finally {
    client.release();
  }
  if (report.committed) assistant.bust(co);
  return report;
}

module.exports = { listFaqs, getFaq, createFaq, updateFaq, importFaqFile, autoLinkProblems, ATOM_ITEM_START };
