const { assertStartupConfig, parsePort, normaliseBasePath } = require('../config/env');

const base = {
  isProduction: false,
  authMode: 'live',
  basePath: '/Atom',
  sessionSecret: '',
};

describe('assertStartupConfig', () => {
  it('accepts a normal development config', () => {
    expect(() => assertStartupConfig(base)).not.toThrow();
  });

  it('allows AUTH_MODE=mock in development', () => {
    expect(() => assertStartupConfig({ ...base, authMode: 'mock' })).not.toThrow();
  });

  it('refuses AUTH_MODE=mock in production', () => {
    expect(() =>
      assertStartupConfig({ ...base, isProduction: true, authMode: 'mock', sessionSecret: 'x'.repeat(40) })
    ).toThrow(/AUTH_MODE=mock is not allowed/);
  });

  it('requires a long SESSION_SECRET in production', () => {
    expect(() => assertStartupConfig({ ...base, isProduction: true, sessionSecret: 'short' })).toThrow(
      /SESSION_SECRET/
    );
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
