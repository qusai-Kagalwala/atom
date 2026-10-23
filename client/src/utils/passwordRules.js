// Same rule as the server (passwords.service.js): at least 8 characters.
// "Different from the current one" is checked by the server.
export const MIN_PASSWORD = 8;

export function newPasswordErrors(next, confirm) {
  const errors = {};
  if (next.length < MIN_PASSWORD) errors.next = `At least ${MIN_PASSWORD} characters.`;
  if (confirm !== next) errors.confirm = 'Passwords do not match.';
  return errors;
}
