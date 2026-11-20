/**
 * Claude Administrator: Google Classroom → Telegram bot.
 *
 * Runs in your SCHOOL Google account (Google Apps Script, free). Every hour it
 * reads your Classroom assignments (read-only, as you) and sends them to the bot.
 * It uses its own password (CLASSROOM_SECRET), which can ONLY send assignments
 * to the bot. It can't read your to-dos, calendar or anything else.
 *
 * Setup (once):
 *   1. Go to script.google.com while signed in to your SCHOOL account → New project.
 *   2. Replace everything in Code.gs with this file. Paste CLASSROOM_SECRET (from .env) below.
 *   3. On the left, "Services" (+) → "Google Classroom API" → Add.
 *   4. Ctrl+S to save. In the function dropdown pick "setup", then ▶ Run.
 *   5. Allow the permissions (Advanced → Go to project → Allow if Google warns).
 *   It syncs right away, then every hour by itself. No deployment needed.
 */

const BOT_URL = "https://haneul.YOUR-SUBDOMAIN.workers.dev/classroom";
const SECRET = "PASTE_CLASSROOM_SECRET_HERE";
const DAYS_BACK = 21; // also include assignments due (or posted) in the last 3 weeks, so missing work shows up

/** Run once: creates the hourly timer and does a first sync. */
function setup() {
  ScriptApp.getProjectTriggers().forEach((t) => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger("syncClassroom").timeBased().everyHours(1).create();
  syncClassroom();
}

function syncClassroom() {
  const since = new Date(Date.now() - DAYS_BACK * 86400000);
  const courses = Classroom.Courses.list({ studentId: "me", courseStates: ["ACTIVE"], pageSize: 50 }).courses || [];
  const assignments = [];
  const errors = [];
  let skippedOld = 0;
  let totalWork = 0;

  courses.forEach((course) => {
    let work = [];
    try {
      // (students may only see published work, so no state filter is needed)
      work = Classroom.Courses.CourseWork.list(course.id, { pageSize: 60 }).courseWork || [];
      totalWork += work.length;
    } catch (err) {
      errors.push(`${course.name}: ${err.message}`);
      return;
    }
    const submissions = {};
    try {
      (Classroom.Courses.CourseWork.StudentSubmissions.list(course.id, "-", { userId: "me", pageSize: 200 }).studentSubmissions || [])
        .forEach((s) => (submissions[s.courseWorkId] = s));
    } catch (err) {
      errors.push(`${course.name} (submissions): ${err.message}`);
    }

    work.forEach((w) => {
      let dueDate = null;
      let dueTime = null;
      if (w.dueDate) {
        const d = w.dueDate;
        dueDate = `${d.year}-${String(d.month).padStart(2, "0")}-${String(d.day).padStart(2, "0")}`;
        if (w.dueTime) {
          // Classroom stores due times in UTC
          dueTime = new Date(Date.UTC(d.year, d.month - 1, d.day, w.dueTime.hours || 0, w.dueTime.minutes || 0)).toISOString();
        }
      }
      const when = new Date(dueTime || (dueDate ? dueDate + "T12:00:00Z" : w.creationTime));
      if (when < since) {
        skippedOld++; // old work: skip
        return;
      }

      const s = submissions[w.id];
      assignments.push({
        id: w.id,
        course: course.name,
        title: w.title,
        dueDate: dueDate,
        dueTime: dueTime,
        state: s ? s.state : "NEW",
        late: s ? !!s.late : false,
        link: w.alternateLink,
      });
    });
  });

  const res = UrlFetchApp.fetch(BOT_URL, {
    method: "post",
    contentType: "application/json",
    headers: { Authorization: "Bearer " + SECRET },
    payload: JSON.stringify({ assignments: assignments }),
    muteHttpExceptions: true,
  });
  Logger.log(
    `Sent ${assignments.length} assignments from ${courses.length} classes → bot answered ${res.getResponseCode()}: ${res.getContentText()}\n` +
      `Coursework found: ${totalWork} · skipped as older than ${DAYS_BACK} days: ${skippedOld} · errors: ${errors.length}` +
      (errors.length ? `\nFirst errors:\n${errors.slice(0, 3).join("\n")}` : "")
  );
}
