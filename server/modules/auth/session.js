// Role + company choice and the user shape the API returns. Role constants come from shared/roles.json.
const { roles: ROLES } = require('../../../shared/roles.json');

const ROLE_KEYS = Object.keys(ROLES);

function highestRole(granted) {
  return [...granted].sort((a, b) => (ROLES[b]?.rank ?? 0) - (ROLES[a]?.rank ?? 0))[0] || null;
}

// Last-used role on this device if still allowed, otherwise the highest allowed role.
function pickActiveRole(allowed, preferred) {
  if (preferred && allowed.includes(preferred)) return preferred;
  return highestRole(allowed);
}

// Roles the user may use inside one company (companyId null = no company: Super Admin console only).
//   Employee and Super Admin: any company. Admin and Staff (Engineer): only their own company
//   (Staff also needs an occupation there).
function rolesIn(row, companyId) {
  const roles = row.roles || [];
  if (companyId == null) return roles.filter((r) => r === 'SUPER_ADMIN');
  const own = row.staff_company_id != null && String(row.staff_company_id) === String(companyId);
  return roles.filter(
    (r) => r === 'EMPLOYEE' || r === 'SUPER_ADMIN' || (own && (r === 'ADMIN' || (r === 'ENGINEER' && row.occupation_id != null)))
  );
}

// The company to open when none was asked for: their own (Admin / Staff), else the first active one.
function defaultCompanyId(row, companies) {
  const own = row.staff_company_id != null && companies.find((c) => String(c.id) === String(row.staff_company_id));
  if (own && rolesIn(row, own.id).length) return String(own.id);
  const first = companies.find((c) => rolesIn(row, c.id).length);
  return first ? String(first.id) : null;
}

// The only user object the auth API returns. Never includes a password.
// displayName follows the user's choice (English / Arabic) and falls back to English.
// row.company = the session's company (loaded by loadSessionUser) or null.
function toPublicUser(row, activeRole) {
  const name = row.name || (row.employee_id ? `Employee ${row.employee_id}` : null);
  const nameArabic = row.name_arabic || null;
  const nameLanguage = row.name_language === 'ar' && nameArabic ? 'ar' : 'en';
  const company = row.company ? { id: String(row.company.id), code: row.company.code, name: row.company.name } : null;
  return {
    id: String(row.id),
    loginType: row.login_type,
    itsNumber: row.its_number || null,
    employeeId: row.employee_id || null,
    name,
    nameArabic,
    nameLanguage,
    displayName: nameLanguage === 'ar' ? nameArabic : name,
    email: row.email || null,
    roles: row.roles,
    activeRole,
    // The company this session works in, and the roles available there (role switcher).
    company,
    companyId: company ? company.id : null,
    rolesHere: rolesIn(row, company ? company.id : null),
    // Where they are Admin / Staff, and their occupation (shown instead of "Engineer").
    staffCompany: row.staff_company_id
      ? { id: String(row.staff_company_id), code: row.staff_company_code, name: row.staff_company_name }
      : null,
    occupation: row.occupation_name || null,
    // Still on a temporary password (employee ID / Super Admin reset): only "Set your password" works.
    mustChangePassword: row.login_type === 'EMPLOYEE_ID' && Boolean(row.must_change_password),
  };
}

module.exports = { ROLE_KEYS, highestRole, pickActiveRole, rolesIn, defaultCompanyId, toPublicUser };
