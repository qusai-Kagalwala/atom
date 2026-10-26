// eJamaat SOAP transport (from the eJamaat Update Kit, Oct 2026).
// Minimal SOAP 1.1 client for the eJamaat "EjamaatServices" endpoint. Replaces the `soap`
// package, which first downloads the service's WSDL — that download (…asmx?wsdl) now fails
// with HTTP 500 even though normal calls still work. This module NEVER requests the WSDL:
// it POSTs a hand-built envelope with Node's built-in fetch (Node 18+).
//
// Changes for ATOM: reads config.ejamaat from config/env, "[ATOM]" log label, the two
// non-characters written as \u escapes, refuses to run without URL / app key.
//
// SECURITY: never logs an answer, the password or the app key — only the operation name and
// HTTP status. Error messages are fixed text, never built from the service's reply (a
// "refused caller" answer contains the app key).

const { config } = require('../config/env');

const NAMESPACE = 'http://localhost/eJAS/EjamaatServices';
const MAX_RESPONSE_BYTES = 8 * 1024 * 1024;
const MAX_XML_DEPTH = 256;
const NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_.-]*$/;
const REFUSED_PREFIX = 'Invalid Access for IP';
// Characters XML 1.0 cannot carry at all (control chars, U+FFFE/U+FFFF).
const ILLEGAL_XML_CHARS = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\uFFFE\uFFFF]/;

// EJAMAAT_SOAP_URL may still end in ?wsdl (as before); it is stripped.
function serviceUrl() {
  return String(config.ejamaat.soapUrl || '').trim().replace(/\?wsdl$/i, '');
}

function escapeXml(value) {
  const text = String(value);
  if (ILLEGAL_XML_CHARS.test(text)) {
    throw new Error('Ejamaat request value contains a character that cannot be sent.');
  }
  return text.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
}

function assertName(name, what) {
  if (typeof name !== 'string' || !NAME_PATTERN.test(name)) {
    throw new Error(`Invalid Ejamaat ${what} name.`);
  }
}

function buildEnvelope(operation, fields) {
  assertName(operation, 'operation');
  const body = Object.entries(fields)
    .map(([field, value]) => {
      assertName(field, 'field');
      return `<${field}>${escapeXml(value)}</${field}>`;
    })
    .join('');
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/">' +
    `<soap:Body><${operation} xmlns="${NAMESPACE}">${body}</${operation}></soap:Body>` +
    '</soap:Envelope>'
  );
}

/* ─── Minimal XML reader ───────────────────────────────────────────────── */
// Handles exactly what a SOAP answer needs: elements, text, CDATA, comments,
// processing instructions. Namespace prefixes are dropped (local names only),
// attributes are skipped, DOCTYPE/ENTITY declarations are rejected outright,
// and only the five predefined + numeric entities are decoded.

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-fA-F]+|#[0-9]+|lt|gt|amp|quot|apos);/g, (match, entity) => {
    switch (entity) {
      case 'lt':
        return '<';
      case 'gt':
        return '>';
      case 'amp':
        return '&';
      case 'quot':
        return '"';
      case 'apos':
        return "'";
      default: {
        const code =
          entity[1] === 'x' ? parseInt(entity.slice(2), 16) : parseInt(entity.slice(1), 10);
        return Number.isInteger(code) && code >= 0 && code <= 0x10ffff
          ? String.fromCodePoint(code)
          : match;
      }
    }
  });
}

function localName(qualified) {
  const colon = qualified.indexOf(':');
  return colon === -1 ? qualified : qualified.slice(colon + 1);
}

function findTagEnd(xml, from) {
  let quote = null;
  for (let i = from; i < xml.length; i += 1) {
    const ch = xml[i];
    if (quote) {
      if (ch === quote) quote = null;
    } else if (ch === '"' || ch === "'") {
      quote = ch;
    } else if (ch === '>') {
      return i;
    }
  }
  return -1;
}

function parseXml(xml) {
  const root = { qname: '#document', name: '#document', children: [], text: '' };
  const stack = [root];
  let i = 0;

  while (i < xml.length) {
    const top = stack[stack.length - 1];
    const lt = xml.indexOf('<', i);
    if (lt === -1) {
      top.text += decodeEntities(xml.slice(i));
      break;
    }
    if (lt > i) top.text += decodeEntities(xml.slice(i, lt));

    if (xml.startsWith('<!--', lt)) {
      const end = xml.indexOf('-->', lt + 4);
      if (end === -1) throw new Error('malformed xml');
      i = end + 3;
    } else if (xml.startsWith('<![CDATA[', lt)) {
      const end = xml.indexOf(']]>', lt + 9);
      if (end === -1) throw new Error('malformed xml');
      top.text += xml.slice(lt + 9, end);
      i = end + 3;
    } else if (xml.startsWith('<?', lt)) {
      const end = xml.indexOf('?>', lt + 2);
      if (end === -1) throw new Error('malformed xml');
      i = end + 2;
    } else if (xml.startsWith('<!', lt)) {
      throw new Error('unsupported xml markup');
    } else if (xml[lt + 1] === '/') {
      const end = xml.indexOf('>', lt);
      if (end === -1) throw new Error('malformed xml');
      const qname = xml.slice(lt + 2, end).trim();
      if (stack.length <= 1 || stack[stack.length - 1].qname !== qname) {
        throw new Error('malformed xml');
      }
      stack.pop();
      i = end + 1;
    } else {
      const end = findTagEnd(xml, lt + 1);
      if (end === -1) throw new Error('malformed xml');
      let tag = xml.slice(lt + 1, end);
      const selfClosing = tag.endsWith('/');
      if (selfClosing) tag = tag.slice(0, -1);
      const match = /^[^\s/>]+/.exec(tag);
      if (!match) throw new Error('malformed xml');
      const node = {
        qname: match[0],
        name: localName(match[0]),
        children: [],
        text: '',
      };
      top.children.push(node);
      if (!selfClosing) {
        if (stack.length >= MAX_XML_DEPTH) throw new Error('xml too deep');
        stack.push(node);
      }
      i = end + 1;
    }
  }

  if (stack.length !== 1) throw new Error('malformed xml');
  return root;
}

function childNamed(node, name) {
  return node.children.find((child) => child.name === name) || null;
}

function findDescendant(node, name) {
  const pending = [node];
  while (pending.length > 0) {
    const current = pending.shift();
    if (current.name === name) return current;
    pending.push(...current.children);
  }
  return null;
}

function rowFromElement(element) {
  const row = {};
  for (const column of element.children) {
    if (column.children.length === 0) row[column.name] = column.text;
  }
  return row;
}

/* ─── Transport ────────────────────────────────────────────────────────── */

async function readLimited(res, operation) {
  const declared = Number(res.headers.get('content-length'));
  if (Number.isFinite(declared) && declared > MAX_RESPONSE_BYTES) {
    throw new Error(`Ejamaat ${operation}: response too large.`);
  }
  if (!res.body) return '';
  const chunks = [];
  let total = 0;
  for await (const chunk of res.body) {
    total += chunk.length;
    if (total > MAX_RESPONSE_BYTES) {
      throw new Error(`Ejamaat ${operation}: response too large.`);
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

/**
 * Calls one Ejamaat operation. Resolves to:
 *   text — the decoded text of <OperationResult>, or null when absent
 *   rows — every element directly inside <NewDataSet> as { column: text }, or []
 * Rejects (with a fixed-text message) on: non-200 status, SOAP Fault, response
 * over 8 MB, timeout, no connection, a reply with no <OperationResponse>, or a
 * "refused caller" answer ("Invalid Access for IP …").
 */
async function callOperation(operation, fields) {
  const url = serviceUrl();
  if (!url || !config.ejamaat.appKey) throw new Error('EJAMAAT_SOAP_URL and EJAMAAT_APP_KEY are not set.');
  const envelope = buildEnvelope(operation, fields);
  const timeoutMs = Number(config.ejamaat.timeoutMs) || 15000;

  let xml;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'text/xml; charset=utf-8',
        SOAPAction: `"${NAMESPACE}/${operation}"`,
      },
      body: envelope,
      signal: AbortSignal.timeout(timeoutMs),
    });

    console.log(`[ATOM] Ejamaat ${operation} HTTP ${res.status}`);

    if (res.status !== 200) {
      if (res.body) await res.body.cancel().catch(() => {});
      throw new Error(`Ejamaat ${operation}: HTTP ${res.status}.`);
    }
    xml = await readLimited(res, operation);
  } catch (err) {
    if (err && err.name === 'TimeoutError') {
      throw new Error(`Ejamaat ${operation}: timed out after ${timeoutMs} ms.`);
    }
    if (err && err.name === 'TypeError') {
      const code = err.cause && err.cause.code ? ` (${err.cause.code})` : '';
      throw new Error(`Ejamaat ${operation}: could not connect${code}.`);
    }
    throw err;
  }

  let document;
  try {
    document = parseXml(xml);
  } catch {
    throw new Error(`Ejamaat ${operation}: unreadable response.`);
  }

  const envelopeNode = childNamed(document, 'Envelope');
  const bodyNode = envelopeNode && childNamed(envelopeNode, 'Body');
  if (!bodyNode) throw new Error(`Ejamaat ${operation}: unreadable response.`);
  if (childNamed(bodyNode, 'Fault')) throw new Error(`Ejamaat ${operation}: SOAP Fault.`);

  const responseNode = childNamed(bodyNode, `${operation}Response`);
  if (!responseNode) throw new Error(`Ejamaat ${operation}: unexpected response.`);

  const resultNode = childNamed(responseNode, `${operation}Result`);
  const text = resultNode ? resultNode.text : null;

  const dataSet = resultNode ? findDescendant(resultNode, 'NewDataSet') : null;
  const rows = dataSet ? dataSet.children.map(rowFromElement) : [];

  const refused =
    (typeof text === 'string' && text.trim().startsWith(REFUSED_PREFIX)) ||
    rows.some((row) => typeof row.Result === 'string' && row.Result.trim().startsWith(REFUSED_PREFIX));
  if (refused) throw new Error(`Ejamaat ${operation}: caller refused by Ejamaat.`);

  return { text, rows };
}

module.exports = { callOperation, buildEnvelope, parseXml, serviceUrl, NAMESPACE };
