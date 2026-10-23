const { assertStartupConfig, parsePort, normaliseBasePath } = require('../config/env');

const SECRET = 'x'.repeat(40);

const base = {
  isProduction: false,
  authMode: 'live',
  basePath: '/Atom',
  sessionSecret: SECRET,
  ejamaat: { soapUrl: '', appKey: '' },
};

const prod = {
  ...base,
  isProduction: true,
  ejamaat: { soapUrl: 'https://ejamaat.example/Service.asmx?wsdl', appKey: 'key' },
};

describe('assertStartupConfig', () => {
  it('accepts a normal development config (eJamaat may be empty in dev)', () => {
    expect(() => assertStartupConfig(base)).not.toThrow();
  });

  it('allows AUTH_MODE=mock in development', () => {
    expect(() => assertStartupConfig({ ...base, authMode: 'mock' })).not.toThrow();
  });

  it('accepts a complete production config', () => {
    expect(() => assertStartupConfig(prod)).not.toThrow();
  });

  it('refuses AUTH_MODE=mock in production', () => {
    expect(() => assertStartupConfig({ ...prod, authMode: 'mock' })).toThrow(/AUTH_MODE=mock is not allowed/);
  });

  it('requires a long SESSION_SECRET in every environment', () => {
    expect(() => assertStartupConfig({ ...base, sessionSecret: '' })).toThrow(/SESSION_SECRET/);
    expect(() => assertStartupConfig({ ...prod, sessionSecret: 'short' })).toThrow(/SESSION_SECRET/);
  });

  it('requires eJamaat settings in production live mode', () => {
    expect(() => assertStartupConfig({ ...prod, ejamaat: { soapUrl: '', appKey: '' } })).toThrow(/EJAMAAT_SOAP_URL/);
  });

  it('requires https for the eJamaat URL in production', () => {
    expect(() =>
      assertStartupConfig({ ...prod, ejamaat: { soapUrl: 'http://ejamaat.example/x?wsdl', appKey: 'k' } })
    ).toThrow(/https/);
  });

  it('rejects an unknown AUTH_MODE', () => {
    expect(() => assertStartupConfig({ ...base, authMode: 'off' })).toThrow(/AUTH_MODE must be/);
  });

  it('rejects any base path other than exactly /Atom', () => {
    expect(() => assertStartupConfig({ ...base, basePath: '/atom' })).toThrow(/BASE_PATH/);
  });
});

describe('parsePort', () => {
  it('defaults to 3000', () => expect(parsePort(undefined)).toBe(3000));
  it('converts numeric strings', () => expect(parsePort('4000')).toBe(4000));
  it('keeps iisnode named pipes as strings', () => {
    const pipe = '\\\\.\\pipe\\abc-123';
    expect(parsePort(pipe)).toBe(pipe);
  });
});

describe('normaliseBasePath', () => {
  it('strips trailing slashes and adds a leading slash', () => {
    expect(normaliseBasePath('/Atom/')).toBe('/Atom');
    expect(normaliseBasePath('Atom')).toBe('/Atom');
    expect(normaliseBasePath(undefined)).toBe('/Atom');
  });
});
