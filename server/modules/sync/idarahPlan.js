// Pure mapping: Idarah view rows → what ATOM should contain. No database access here.
// Rules: ATOM_Decisions.md §4.

// '' / whitespace / null / undefined → null; everything else → trimmed string.
function clean(value) {
  if (value === null || value === undefined) return null;
  const s = String(value).trim();
  return s === '' ? null : s;
}

// Lower-cases keys so the plan works on view rows and mirror rows alike.
function lowerKeys(row) {
  const out = {};
  for (const [k, v] of Object.entries(row)) out[k.toLowerCase()] = v;
  return out;
}

const ITS_RE = /^\d{8}$/;
const SHORT_ID_RE = /^\d{1,7}$/; // employee IDs (1002–9998 today)

// Who a row belongs to.
//   { kind: 'ITS', id, viaTeacherId }  |  { kind: 'EMPLOYEE', id }  |  { skip: reason }
function resolvePerson(r) {
  const ejamaat = clean(r.ejamaat_no);
  const teacher = clean(r.teacher_id);

  if (ejamaat) {
    return ITS_RE.test(ejamaat) ? { kind: 'ITS', id: ejamaat, viaTeacherId: false } : { skip: 'invalid_ejamaat_no' };
  }
  if (teacher && ITS_RE.test(teacher)) return { kind: 'ITS', id: teacher, viaTeacherId: true };
  if (teacher && SHORT_ID_RE.test(teacher)) return { kind: 'EMPLOYEE', id: teacher };
  return { skip: 'no_person_id' };
}

// Stable order, so "first non-empty value" is the same on every run.
function sortKey(r) {
  return [r.idarah_id, r.post, r.post_tbq, r.ejamaat_no, r.teacher_id].map((v) => clean(v) ?? '').join('\u0001');
}

function firstFilled(target, field, value) {
  if (target[field] == null && value != null) target[field] = value;
}

function buildPlan(sourceRows) {
  const rows = sourceRows
    .map((raw) => {
      const r = lowerKeys(raw);
      return { r, key: sortKey(r) };
    })
    .sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0))
    .map((x) => x.r);

  const departments = new Map(); // idarahId → { idarahId, name, nameArabic, category, categoryArabic, email }
  const people = new Map(); // ITS → { its, name, nameArabic, email, mobile }
  const posts = new Map(); // key → post
  const skipped = { no_idarah_id: 0, invalid_ejamaat_no: 0, no_person_id: 0 };
  let validRows = 0;
  let viaTeacherId = 0;
  let employeeRows = 0;

  for (const r of rows) {
    const idarahId = clean(r.idarah_id);
    if (!idarahId) {
      skipped.no_idarah_id += 1; // e.g. designation-only rows from the view's FULL OUTER JOIN
      continue;
    }

    // Departments come from every row that has an Idarah, even if the person is unusable.
    if (!departments.has(idarahId)) departments.set(idarahId, { idarahId });
    const dept = departments.get(idarahId);
    firstFilled(dept, 'name', clean(r.dptnm) ?? clean(r.expr1));
    firstFilled(dept, 'nameArabic', clean(r.dptnm_arabic));
    firstFilled(dept, 'category', clean(r.idarahcat));
    firstFilled(dept, 'categoryArabic', clean(r.idarahcat_arabic));
    firstFilled(dept, 'email', clean(r.dpt_email));

    const person = resolvePerson(r);
    if (person.skip) {
      skipped[person.skip] += 1;
      continue;
    }
    validRows += 1;

    if (person.kind === 'ITS') {
      if (person.viaTeacherId) viaTeacherId += 1;
      if (!people.has(person.id)) people.set(person.id, { its: person.id });
      const p = people.get(person.id);
      firstFilled(p, 'name', clean(r.u_name));
      firstFilled(p, 'nameArabic', clean(r.t_name));
      firstFilled(p, 'email', clean(r.t_email));
      firstFilled(p, 'mobile', clean(r.mobile));
    } else {
      employeeRows += 1;
    }

    const post = clean(r.post) ?? '';
    const postTbq = clean(r.post_tbq) ?? '';
    const key = [person.kind, person.id, idarahId, post, postTbq].join('\u0001');
    if (!posts.has(key)) {
      posts.set(key, {
        ownerKind: person.kind,
        ownerId: person.id,
        idarahId,
        post,
        postTbq,
        postId: clean(r.post_id),
        postCategory: clean(r.post_category),
        postAbbrev: clean(r.posr_abbrv),
        intercom: clean(r.idarah_intercom),
        officeNo: clean(r.office_no),
      });
    }
  }

  const skippedRows = Object.values(skipped).reduce((a, b) => a + b, 0);

  return {
    departments: [...departments.values()],
    people: [...people.values()],
    posts: [...posts.values()],
    counts: {
      sourceRows: rows.length,
      validRows,
      skippedRows,
      skipped,
      viaTeacherId,
      employeeRows,
    },
  };
}

// Guard (§4 rule 2). 0 valid rows always blocks — even forced — because it would deactivate everyone.
function checkGuard(validRows, lastGoodValidRows, force) {
  if (validRows === 0) {
    return { ok: false, reason: 'The view returned no usable rows (Hijri year rollover?). Old data kept.' };
  }
  if (lastGoodValidRows && validRows < lastGoodValidRows * 0.5 && !force) {
    return {
      ok: false,
      reason: `Only ${validRows} usable rows, under 50% of the last good run (${lastGoodValidRows}). Old data kept. Run with force to accept.`,
    };
  }
  return { ok: true };
}

module.exports = { buildPlan, checkGuard, resolvePerson, clean };
