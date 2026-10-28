// Dev seed: test accounts for local login. Refuses to run when NODE_ENV=production.
// Usage: npm run seed:dev   (from server/, after npm run migrate)
//
//   ITS 30328701  Qusai          Employee + Staff (Engineer, AVIT) + Admin (AVIT) + Super Admin
//                                (any password in AUTH_MODE=mock)
//   Employee ID 1000             Employee only, password 1000       (real IDs start at 1002)
//
// Idempotent: re-running reactivates the accounts and adds missing roles. It never resets a
// password or overwrites a name that was changed later.

const DEV_USERS = [
  {
    loginType: 'ITS',
    itsNumber: '30328701',
    name: 'Qusai Kagalwala',
    roles: ['EMPLOYEE', 'ENGINEER', 'ADMIN', 'SUPER_ADMIN'],
    company: 'AVIT',
    occupation: 'Engineer',
  },
  {
    loginType: 'EMPLOYEE_ID',
    employeeId: '1000',
    password: '1000',
    name: 'Test Employee',
    roles: ['EMPLOYEE'],
  },
];

async function upsertUser(client, u) {
  if (u.loginType === 'ITS') {
    const { rows } = await client.query(
      `INSERT INTO users (login_type, its_number, name, source)
       VALUES ('ITS', $1::text, $2::text, 'manual')
       ON CONFLICT (its_number) WHERE its_number IS NOT NULL
       DO UPDATE SET is_active = TRUE
       RETURNING id`,
      [u.itsNumber, u.name]
    );
    return rows[0].id;
  }

  const { rows } = await client.query(
    `INSERT INTO users (login_type, employee_id, name, legacy_password, source)
     VALUES ('EMPLOYEE_ID', $1::text, $2::text, $3::text, 'manual')
     ON CONFLICT (employee_id) WHERE employee_id IS NOT NULL
     DO UPDATE SET is_active = TRUE
     RETURNING id`,
    [u.employeeId, u.name, u.password]
  );
  return rows[0].id;
}

async function seedDevUsers(client, { nodeEnv = process.env.NODE_ENV, log = console.log } = {}) {
  if (nodeEnv === 'production') {
    throw new Error('Refusing to seed dev users when NODE_ENV=production.');
  }

  await client.query('BEGIN');
  try {
    for (const u of DEV_USERS) {
      const userId = await upsertUser(client, u);
      await client.query(
        `INSERT INTO user_roles (user_id, role)
         SELECT $1::bigint, r FROM unnest($2::app_role[]) AS r
         ON CONFLICT (user_id, role) DO NOTHING`,
        [userId, u.roles]
      );
      if (u.company) {
        // Their one company (Admin / Staff) — only if they have none yet.
        await client.query(
          `INSERT INTO user_company (user_id, service_unit_id, occupation_id)
           SELECT $1::bigint, s.id, o.id FROM service_units s
             LEFT JOIN occupations o ON o.service_unit_id = s.id AND lower(o.name) = lower($3::text)
            WHERE s.code = $2::text
           ON CONFLICT (user_id) DO NOTHING`,
          [userId, u.company, u.occupation || '']
        );
      }
      log(`Seed: ${u.itsNumber ? `ITS ${u.itsNumber}` : `Employee ID ${u.employeeId}`} → ${u.roles.join(', ')}`);
    }
    await client.query('COMMIT');
  } catch (err) {
    await client.query('ROLLBACK');
    throw err;
  }
}

async function main() {
  const { config } = require('../../config/env');
  const pool = require('../pool');
  const client = await pool.connect();
  try {
    await seedDevUsers(client, { nodeEnv: config.nodeEnv });
  } finally {
    client.release();
    await pool.end();
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err.message);
    process.exit(1);
  });
}

module.exports = { seedDevUsers, DEV_USERS };
