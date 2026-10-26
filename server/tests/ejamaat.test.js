// eJamaat client + SOAP transport against a small local HTTP server standing in for eJamaat.
// No network beyond 127.0.0.1. (Adapted from the eJamaat Update Kit tests.)
const http = require('http');
const { config } = require('../config/env');
const client = require('../services/ejamaatClient');
const { callOperation, buildEnvelope, parseXml, serviceUrl } = require('../services/ejamaatSoap');

const NS = 'http://localhost/eJAS/EjamaatServices';
const KEY = 'test-app-key'; // tests/setupEnv.js
const PASSWORD = 'S3cret<&>pw';

let server;
let baseUrl;
let requests;
let handler;
let logged;
const original = { ...config.ejamaat };

const envelope = (inner) =>
  '<?xml version="1.0" encoding="utf-8"?>' +
  '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" ' +
  'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema">' +
  `<soap:Body>${inner}</soap:Body></soap:Envelope>`;
const textAnswer = (op, text) => envelope(`<${op}Response xmlns="${NS}"><${op}Result>${text}</${op}Result></${op}Response>`);
const fault = envelope('<soap:Fault><faultcode>soap:Server</faultcode><faultstring>boom</faultstring></soap:Fault>');

function reply(res, status, body, headers = {}) {
  res.writeHead(status, { 'Content-Type': 'text/xml; charset=utf-8', ...headers });
  res.end(body);
}

beforeAll(async () => {
  server = http.createServer((req, res) => {
    const chunks = [];
    req.on('data', (c) => chunks.push(c));
    req.on('end', () => {
      const body = Buffer.concat(chunks).toString('utf8');
      requests.push({ method: req.method, url: req.url, headers: req.headers, body });
      handler(req, res, body);
    });
  });
  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve));
  baseUrl = `http://127.0.0.1:${server.address().port}/ejamaatservices.asmx`;
});

afterAll(async () => {
  Object.assign(config.ejamaat, original);
  await new Promise((resolve) => server.close(resolve));
});

beforeEach(() => {
  requests = [];
  handler = (req, res) => reply(res, 200, textAnswer('AuthenticateEjamaatId', '1'));
  Object.assign(config.ejamaat, { soapUrl: `${baseUrl}?wsdl`, appKey: KEY, timeoutMs: 2000 });
  logged = [];
  for (const level of ['log', 'warn', 'error', 'info']) {
    jest.spyOn(console, level).mockImplementation((...args) => logged.push(args.map(String).join(' ')));
  }
});

afterEach(() => {
  jest.restoreAllMocks();
  // Nothing sensitive ever reaches the logs.
  const all = logged.join('\n');
  expect(all).not.toContain(KEY);
  expect(all).not.toContain(PASSWORD);
  expect(all).not.toMatch(/Invalid Access/);
});

describe('login (AuthenticateEjamaatId)', () => {
  test('"1" → success, with exactly the request eJamaat expects; never downloads the WSDL', async () => {
    await expect(client.authenticate('30328701', PASSWORD)).resolves.toEqual({ success: true });
    expect(requests).toHaveLength(1);
    const [r] = requests;
    expect(r.method).toBe('POST');
    expect(r.url).toBe('/ejamaatservices.asmx'); // ?wsdl stripped, no GET for the WSDL
    expect(r.headers['content-type']).toBe('text/xml; charset=utf-8');
    expect(r.headers.soapaction).toBe(`"${NS}/AuthenticateEjamaatId"`);
    expect(r.body).toContain(`<AuthenticateEjamaatId xmlns="${NS}">`);
    expect(r.body).toContain('<EjamaatId>30328701</EjamaatId>');
    expect(r.body).toContain('<Password>S3cret&lt;&amp;&gt;pw</Password>'); // escaped on the wire
    expect(r.body).toContain(`<strKey>${KEY}</strKey>`);
    expect(logged).toEqual(['[ATOM] Ejamaat AuthenticateEjamaatId HTTP 200']);
  });

  test('"2" (wrong password), anything else, or no result → not signed in (not an error)', async () => {
    for (const answer of ['2', '0', '11', 'true', '']) {
      handler = (req, res) => reply(res, 200, textAnswer('AuthenticateEjamaatId', answer));
      // eslint-disable-next-line no-await-in-loop
      await expect(client.authenticate('30328701', PASSWORD)).resolves.toEqual({ success: false });
    }
    handler = (req, res) => reply(res, 200, envelope(`<AuthenticateEjamaatIdResponse xmlns="${NS}" />`));
    await expect(client.authenticate('30328701', PASSWORD)).resolves.toEqual({ success: false });
  });

  test('a non-8-digit ITS is refused locally; nothing is sent', async () => {
    for (const its of ['1234', '303287011', 'abcdefgh', '', null]) {
      // eslint-disable-next-line no-await-in-loop
      await expect(client.authenticate(its, PASSWORD)).resolves.toEqual({ success: false });
    }
    expect(requests).toHaveLength(0);
  });

  test('isSuccess is strict', () => {
    for (const [raw, ok] of [['1', true], [' 1 ', true], [1, true], ['2', false], ['', false], [null, false], ['11', false]]) {
      expect(client.isSuccess(raw)).toBe(ok);
    }
  });
});

describe('failures → thrown (login answers 502 "Could not reach the authentication service")', () => {
  test('HTTP 500, SOAP Fault (200 or 500), refused caller, unreadable XML, wrong response element', async () => {
    const cases = [
      [(req, res) => reply(res, 500, 'oops'), /HTTP 500/],
      [(req, res) => reply(res, 200, fault), /SOAP Fault/],
      [(req, res) => reply(res, 500, fault), /HTTP 500/],
      [(req, res) => reply(res, 200, textAnswer('AuthenticateEjamaatId', `Invalid Access for IP 10.0.0.9 key ${KEY}`)), /caller refused/],
      [(req, res) => reply(res, 200, '<not xml'), /unreadable response/],
      [(req, res) => reply(res, 200, textAnswer('SomethingElse', '1')), /unexpected response/],
    ];
    for (const [h, message] of cases) {
      handler = h;
      // eslint-disable-next-line no-await-in-loop
      const err = await client.authenticate('30328701', PASSWORD).catch((e) => e);
      expect(err).toBeInstanceOf(Error);
      expect(err.message).toMatch(message);
      expect(err.message).not.toContain(KEY);
    }
  });

  test('timeout', async () => {
    config.ejamaat.timeoutMs = 150;
    handler = (req, res) => setTimeout(() => reply(res, 200, textAnswer('AuthenticateEjamaatId', '1')), 600);
    await expect(client.authenticate('30328701', PASSWORD)).rejects.toThrow(/timed out after 150 ms/);
  });

  test('no connection', async () => {
    config.ejamaat.soapUrl = 'http://127.0.0.1:1/ejamaatservices.asmx';
    await expect(client.authenticate('30328701', PASSWORD)).rejects.toThrow(/could not connect/);
  });

  test('answer over 8 MB (declared or streamed)', async () => {
    handler = (req, res) => reply(res, 200, 'x', { 'Content-Length': String(9 * 1024 * 1024) });
    await expect(callOperation('AuthenticateEjamaatId', {})).rejects.toThrow();
    handler = (req, res) => {
      res.writeHead(200, { 'Content-Type': 'text/xml' });
      const chunk = Buffer.alloc(1024 * 1024, 0x61);
      for (let i = 0; i < 9; i += 1) res.write(chunk);
      res.end();
    };
    await expect(callOperation('AuthenticateEjamaatId', {})).rejects.toThrow(/too large/);
  });

  test('URL or app key missing → error before anything is sent', async () => {
    config.ejamaat.appKey = '';
    await expect(client.authenticate('30328701', PASSWORD)).rejects.toThrow(/not set/);
    config.ejamaat.appKey = KEY;
    config.ejamaat.soapUrl = '';
    await expect(client.authenticate('30328701', PASSWORD)).rejects.toThrow(/not set/);
    expect(requests).toHaveLength(0);
  });
});

describe('photo (GetMuminNewPhoto)', () => {
  test('base64 → data URL', async () => {
    handler = (req, res) => reply(res, 200, textAnswer('GetMuminNewPhoto', ' QUJD '));
    await expect(client.getPhoto('30328701')).resolves.toBe('data:image/jpeg;base64,QUJD');
    expect(requests[0].headers.soapaction).toBe(`"${NS}/GetMuminNewPhoto"`);
  });

  test('empty, junk, or any failure → null (never throws)', async () => {
    for (const h of [
      (req, res) => reply(res, 200, textAnswer('GetMuminNewPhoto', '')),
      (req, res) => reply(res, 200, textAnswer('GetMuminNewPhoto', '<b>not base64</b>'.replace(/</g, '&lt;'))),
      (req, res) => reply(res, 500, 'oops'),
    ]) {
      handler = h;
      // eslint-disable-next-line no-await-in-loop
      await expect(client.getPhoto('30328701')).resolves.toBeNull();
    }
    await expect(client.getPhoto('123')).resolves.toBeNull();
  });
});

describe('XML safety', () => {
  test('envelope refuses bad names and characters XML cannot carry', () => {
    expect(() => buildEnvelope('Bad Op', {})).toThrow(/operation/);
    expect(() => buildEnvelope('Op', { 'a b': 1 })).toThrow(/field/);
    expect(() => buildEnvelope('Op', { a: 'x\u0001y' })).toThrow(/cannot be sent/);
    expect(() => buildEnvelope('Op', { a: 'x￾y' })).toThrow(/cannot be sent/);
  });

  test('DOCTYPE / ENTITY (XXE) is rejected; entities decoded; CDATA kept', () => {
    expect(() => parseXml('<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]><x>&e;</x>')).toThrow();
    const doc = parseXml('<a:x xmlns:a="u">A &amp; B &#65;<![CDATA[<raw>]]></a:x>');
    expect(doc.children[0]).toMatchObject({ name: 'x', text: 'A & B A<raw>' });
  });

  test('serviceUrl strips ?wsdl', () => {
    config.ejamaat.soapUrl = ' https://ejas.example/ejamaatservices.asmx?WSDL ';
    expect(serviceUrl()).toBe('https://ejas.example/ejamaatservices.asmx');
  });
});
