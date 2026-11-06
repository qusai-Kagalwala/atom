// Role helpers for the company model (decided 28 Oct 2026). Access follows the ACTIVE role and the
// ACTIVE company of the session (req.user.activeRole, req.user.companyId) — never the union of roles.
//   EMPLOYEE     any company: raise and follow their own tickets / requests there.
//   ENGINEER     "Staff" with an occupation, in their one company only.
//   ADMIN        runs their one company.
//   SUPER_ADMIN  global pages; inside a company they act as its Admin.
const ADMIN_ROLES = ['ADMIN', 'SUPER_ADMIN'];
const STAFF_ROLES = ['ENGINEER', 'ADMIN', 'SUPER_ADMIN'];

const hasCompany = (user) => Boolean(user?.companyId);
// Runs the active company (Admin, or Super Admin inside a company).
const isAdmin = (user) => hasCompany(user) && ADMIN_ROLES.includes(user.activeRole);
const isSuperAdmin = (user) => user?.activeRole === 'SUPER_ADMIN';
const isStaff = (user) => hasCompany(user) && user.activeRole === 'ENGINEER';
// Who may add / edit / move / assign / return assets (decided 5 Nov 2026): the company's Admin, and in AVIT
// also its engineers. Changing status (retire), imports, categories and places stay with the Admin.
const ASSET_EDITOR_COMPANIES = ['AVIT'];
const canEditAssets = (user) => isAdmin(user) || (isStaff(user) && ASSET_EDITOR_COMPANIES.includes(user.company?.code));

module.exports = { ADMIN_ROLES, STAFF_ROLES, hasCompany, isAdmin, isSuperAdmin, isStaff, canEditAssets };
