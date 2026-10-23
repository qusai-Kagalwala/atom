// eJamaat SOAP client with the soap package mocked. No network.
jest.mock('soap', () => ({ createClientAsync: jest.fn() }));

// Fresh copy of the client (and its soap mock) per test, so the cached SOAP client doesn't leak.
function load() {
  let client;
  let soap;
  jest.isolateModules(() => {
    soap = require('soap');
    client = require('../services/ejamaatClient');
  });
  return { ...client, soap };
}

function fakeSoapClient(result) {
  return {
    AuthenticateEjamaatIdAsync: jest.fn().mockResolvedValue([{ AuthenticateEjamaatIdResult: result }]),
    GetMuminNewPhotoAsync: jest.fn().mockResolvedValue([{ GetMuminNewPhotoResult: 'QUJD' }]),
  };
}

describe('isSuccess (fail closed)', () => {
  const { isSuccess } = load();
  it.each([
    ['1', true], [' 1 ', true], [1, true],
    ['2', false], ['', false], [null, false], [undefined, false], ['11', false], ['true', false],
  ])('%j → %s', (raw, expected) => expect(isSuccess(raw)).toBe(expected));
});

describe('authenticate', () => {
  it('sends ITS as a number, the password and the app key, and maps "1" to success', async () => {
    const { authenticate, soap } = load();
    const client = fakeSoapClient('1');
    soap.createClientAsync.mockResolvedValue(client);

    await expect(authenticate('30328701', 'pw')).resolves.toEqual({ success: true });
    expect(client.AuthenticateEjamaatIdAsync).toHaveBeenCalledWith(
      { EjamaatId: 30328701, Password: 'pw', strKey: 'test-app-key' },
      { timeout: 10000 }
    );
    expect(soap.createClientAsync).toHaveBeenCalledWith('https://ejamaat.test/service.asmx?wsdl', {
      wsdl_options: { timeout: 10000 },
    });
  });

  it('maps "2" to failure', async () => {
    const { authenticate, soap } = load();
    soap.createClientAsync.mockResolvedValue(fakeSoapClient('2'));
    await expect(authenticate('30328701', 'pw')).resolves.toEqual({ success: false });
  });

  it('reuses one SOAP client across calls', async () => {
    const { authenticate, soap } = load();
    soap.createClientAsync.mockResolvedValue(fakeSoapClient('1'));
    await authenticate('30328701', 'pw');
    await authenticate('30328701', 'pw');
    expect(soap.createClientAsync).toHaveBeenCalledTimes(1);
  });

  it('throws when the WSDL cannot be loaded, then retries on the next call', async () => {
    const { authenticate, soap } = load();
    soap.createClientAsync.mockRejectedValueOnce(new Error('ENOTFOUND'));
    await expect(authenticate('30328701', 'pw')).rejects.toThrow('ENOTFOUND');

    soap.createClientAsync.mockResolvedValue(fakeSoapClient('1'));
    await expect(authenticate('30328701', 'pw')).resolves.toEqual({ success: true });
    expect(soap.createClientAsync).toHaveBeenCalledTimes(2);
  });
});

describe('getPhoto', () => {
  it('returns a data URL', async () => {
    const { getPhoto, soap } = load();
    soap.createClientAsync.mockResolvedValue(fakeSoapClient('1'));
    await expect(getPhoto('30328701')).resolves.toBe('data:image/jpeg;base64,QUJD');
  });

  it('returns null instead of throwing on failure', async () => {
    const warn = jest.spyOn(console, 'warn').mockImplementation(() => {});
    const { getPhoto, soap } = load();
    soap.createClientAsync.mockRejectedValue(new Error('down'));
    await expect(getPhoto('30328701')).resolves.toBeNull();
    warn.mockRestore();
  });
});
