// Runs before every test file (jest.setupFiles). Values set here win over the real .env,
// because dotenv never overrides variables that already exist.
process.env.NODE_ENV = 'test';
process.env.BASE_PATH = '/Atom';
process.env.AUTH_MODE = 'live';
process.env.SESSION_SECRET = 'test-session-secret-at-least-32-characters-long';
process.env.JWT_EXPIRES_IN = '8h';
process.env.EJAMAAT_SOAP_URL = 'https://ejamaat.test/service.asmx?wsdl';
process.env.EJAMAAT_APP_KEY = 'test-app-key';
