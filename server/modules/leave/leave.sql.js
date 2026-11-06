// SQL pieces for "on leave today" (approved leave covering today in the app's time zone).
// $tz is always passed as a parameter, never put into the SQL text.
// onLeaveUntil(userCol, unitCol, tzParam) → the end date of today's approved leave, or NULL.
const onLeaveUntil = (userCol, unitCol, tzParam) =>
  `(SELECT max(l.end_date) FROM staff_leave l
     WHERE l.user_id = ${userCol} AND l.service_unit_id = ${unitCol} AND l.status = 'APPROVED'
       AND (now() AT TIME ZONE ${tzParam})::date BETWEEN l.start_date AND l.end_date)`;

module.exports = { onLeaveUntil };
