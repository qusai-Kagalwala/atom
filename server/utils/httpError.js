// Errors whose message is safe to show the user. The app error handler returns
// { message, code } for these; any other error becomes a plain 500.
class HttpError extends Error {
  constructor(status, message, code) {
    super(message);
    this.status = status;
    this.code = code;
    this.expose = true;
  }
}

// Out of scope and missing look the same, so IDs can't be probed (ATOM_Decisions.md §6).
const notFound = () => new HttpError(404, 'Not found.', 'not_found');

module.exports = { HttpError, notFound };
