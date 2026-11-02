import http from './http';

// Phase 15: analytics (company Admin), all-companies overview (Super Admin), PDF reports.
export const getAnalytics = (params) => http.get('/analytics', { params }).then((r) => r.data);
export const getOverview = (params) => http.get('/analytics/overview', { params }).then((r) => r.data);
export const listReports = () => http.get('/reports').then((r) => r.data.reports);

// → { blob, filename }. Errors come back as a Blob too: read the server's message out of it.
export async function fetchReport(type, params) {
  try {
    const r = await http.get(`/reports/${type}`, { params, responseType: 'blob', timeout: 120000 });
    const filename = /filename="([^"]+)"/.exec(r.headers['content-disposition'] || '')?.[1] || `ATOM-${type}.pdf`;
    return { blob: r.data, filename };
  } catch (err) {
    const data = err.response?.data;
    if (data instanceof Blob) {
      try {
        const body = JSON.parse(await data.text());
        err.response.data = body;
      } catch {
        /* not JSON */
      }
    }
    throw err;
  }
}
