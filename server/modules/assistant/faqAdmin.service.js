// FAQ bank management (Super Admin, Phase 12).
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
  SELECT f.*, c.name AS ticket_category_name
    FROM faqs f LEFT JOIN categories c ON c.id = f.ticket_category_id`;

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
    source: r.source,
    editedInAtom: Boolean(r.edited_in_atom_at),
    isActive: r.is_active,
    updatedAt: r.updated_at,
  };
  if (!detail) return base;
  return { ...base, keywords: r.keywords, answers: r.answers, detailsEn: r.details_en, ticketInfo: r.ticket_info };
}

async function categoryIds(db) {
  const { rows } = await db.query(
    `SELECT c.id, c.name FROM categories c JOIN service_units s ON s.id = c.service_unit_id
      WHERE s.code = 'AVIT' AND c.is_active`
  );
  return new Map(rows.map((r) => [r.name.toLowerCase(), String(r.id)]));
}
const mappedCategory = (ids, f) => ids.get(ticketCategoryName(f.category, f.item).toLowerCase()) || ids.get('other') || null;

// ---------- read ----------
async function listFaqs({ includeInactive = false } = {}) {
  const { rows } = await pool.query(
    `${SELECT} ${includeInactive ? '' : 'WHERE f.is_active'} ORDER BY f.category, f.item, f.item_id`
  );
  return rows.map((r) => toFaq(r));
}

async function getFaq(id) {
  if (!isId(id)) throw notFound();
  const { rows } = await pool.query(`${SELECT} WHERE f.id = $1::bigint`, [id]);
  if (!rows[0]) throw notFound();
  return toFaq(rows[0], { detail: true });
}

// ---------- add / edit ----------
async function validTicketCategory(db, id) {
  if (id == null || id === '') return null;
  if (!isId(id)) throw bad('Choose a ticket category.', 'bad_category');
  const ids = await categoryIds(db);
  if (![...ids.values()].includes(String(id))) throw bad('Choose a ticket category.', 'bad_category');
  return String(id);
}

async function createFaq(user, body = {}) {
  const f = normaliseFaq(body);
  if (f.error) throw bad(f.error, 'invalid');
  const row = await inTransaction(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock($1::bigint)', [LOCK_KEY]);
    const catId = body.ticketCategoryId != null && body.ticketCategoryId !== ''
      ? await validTicketCategory(db, body.ticketCategoryId)
      : mappedCategory(await categoryIds(db), f);
    const { rows: m } = await db.query('SELECT COALESCE(max(item_id), $1::int - 1) + 1 AS next FROM faqs WHERE item_id >= $1::int', [ATOM_ITEM_START]);
    const { rows } = await db.query(
      `INSERT INTO faqs (item_id, category, item, sub_item, keywords, direct_ticket, answers, details_en, ticket_info,
                         ticket_category_id, source)
       VALUES ($1::int, $2::text, $3::text, $4::text, $5::text[], $6::boolean, $7::jsonb, $8::jsonb, $9::jsonb, $10::bigint, 'atom')
       RETURNING id`,
      [m[0].next, f.category, f.item, f.subItem, f.keywords, f.directTicket, JSON.stringify(f.answers),
        JSON.stringify(f.detailsEn), JSON.stringify(f.ticketInfo), catId]
    );
    return rows[0];
  });
  assistant.bust();
  return getFaq(row.id);
}

async function updateFaq(user, id, body = {}) {
  if (!isId(id)) throw notFound();
  await inTransaction(async (db) => {
    await db.query('SELECT pg_advisory_xact_lock($1::bigint)', [LOCK_KEY]);
    const { rows } = await db.query('SELECT * FROM faqs WHERE id = $1::bigint FOR UPDATE', [id]);
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
    const catId = 'ticketCategoryId' in body ? await validTicketCategory(db, body.ticketCategoryId) : cur.ticket_category_id;
    if ('isActive' in body && typeof body.isActive !== 'boolean') throw bad('Bad status value.', 'invalid');
    const isActive = 'isActive' in body ? body.isActive : cur.is_active;
    await db.query(
      `UPDATE faqs SET category = $2::text, item = $3::text, sub_item = $4::text, keywords = $5::text[],
              direct_ticket = $6::boolean, answers = $7::jsonb, details_en = $8::jsonb, ticket_info = $9::jsonb,
              ticket_category_id = $10::bigint, is_active = $11::boolean,
              edited_in_atom_at = CASE WHEN source = 'json' THEN now() ELSE edited_in_atom_at END
        WHERE id = $1::bigint`,
      [id, f.category, f.item, f.subItem, f.keywords, f.directTicket, JSON.stringify(f.answers),
        JSON.stringify(f.detailsEn), JSON.stringify(f.ticketInfo), catId, isActive]
    );
  });
  assistant.bust();
  return getFaq(id);
}

// ---------- JSON import ----------
class Rollback extends Error {}

async function importFaqFile(buf, { commit = false, keepAtomEdits = true } = {}) {
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
    const ids = await categoryIds(client);
    const { rows: existing } = await client.query('SELECT * FROM faqs');
    const byItem = new Map(existing.map((r) => [r.item_id, r]));

    for (const f of parsed.faqs) {
      const cur = byItem.get(f.itemId);
      const values = [f.category, f.item, f.subItem, f.keywords, f.directTicket, JSON.stringify(f.answers),
        JSON.stringify(f.detailsEn), JSON.stringify(f.ticketInfo), f.hash];
      if (!cur) {
        await client.query(
          `INSERT INTO faqs (item_id, category, item, sub_item, keywords, direct_ticket, answers, details_en, ticket_info,
                             content_hash, ticket_category_id, source)
           VALUES ($1::int, $2::text, $3::text, $4::text, $5::text[], $6::boolean, $7::jsonb, $8::jsonb, $9::jsonb,
                   $10::text, $11::bigint, 'json')`,
          [f.itemId, ...values, mappedCategory(ids, f)]
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

    await client.query(
      `INSERT INTO assistant_settings (id, content) VALUES (1, $1::jsonb) ON CONFLICT (id) DO UPDATE SET content = EXCLUDED.content`,
      [JSON.stringify(parsed.content)]
    );

    if (!commit) throw new Rollback();
    await client.query('COMMIT');
    report.committed = true;
  } catch (err) {
    await client.query('ROLLBACK').catch(() => {});
    if (!(err instanceof Rollback)) throw err;
  } finally {
    client.release();
  }
  if (report.committed) assistant.bust();
  return report;
}

module.exports = { listFaqs, getFaq, createFaq, updateFaq, importFaqFile, ATOM_ITEM_START };
