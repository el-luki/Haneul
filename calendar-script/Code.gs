/**
 * Haneul: add events to your Google Calendar from Telegram.
 *
 * This runs inside YOUR personal Google account (Google Apps Script, free),
 * so the bot never gets your Google password or a Google login token.
 * It only accepts requests that include the secret below.
 *
 * Setup (once):
 *   1. Go to script.google.com while signed in to your PERSONAL Google account → New project.
 *   2. Replace everything in Code.gs with this file. Paste your CALENDAR_SCRIPT_SECRET below.
 *   3. Deploy → New deployment → type "Web app".
 *        Execute as: Me    ·    Who has access: Anyone
 *   4. Authorize (Google warns the app is unverified because you wrote it yourself:
 *      Advanced → Go to project → Allow).
 *   5. Copy the Web app URL (ends in /exec) into .env as CALENDAR_SCRIPT_URL.
 */

const SECRET = "PASTE_CALENDAR_SCRIPT_SECRET_HERE";

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (body.secret !== SECRET) return reply({ ok: false, error: "unauthorized" });

    const calendar = CalendarApp.getDefaultCalendar();
    const MARK = "Added from Telegram (Claude Administrator)"; // old name kept on purpose: it finds events added before the rename

    // Remove all-day events THIS script made (title starts with body.prefix), e.g. to re-place them at a time.
    if (body.action === "delete_all_day") {
      if (!body.prefix) return reply({ ok: false, error: "prefix needed" });
      const events = calendar.getEvents(new Date(body.from + "T00:00:00-05:00"), new Date(body.to + "T23:59:59-05:00"));
      let deleted = 0;
      events.forEach(function (ev) {
        if (ev.isAllDayEvent() && ev.getTitle().indexOf(body.prefix) === 0 && ev.getDescription() === MARK) {
          ev.deleteEvent();
          deleted++;
        }
      });
      return reply({ ok: true, deleted: deleted });
    }

    // Remove specific events THIS script made: exact title + start time ("2026-11-15T16:00", Lima time).
    // Used to clean up duplicates; never touches events you created yourself.
    if (body.action === "delete_events") {
      let removed = 0;
      (body.events || []).slice(0, 50).forEach(function (want) {
        const at = new Date(want.start + ":00-05:00");
        calendar.getEvents(new Date(at.getTime() - 60000), new Date(at.getTime() + 60000)).forEach(function (ev) {
          if (ev.getTitle() === want.title && ev.getDescription() === MARK && Math.abs(ev.getStartTime().getTime() - at.getTime()) < 60000) {
            ev.deleteEvent();
            removed++;
          }
        });
      });
      return reply({ ok: true, deleted: removed });
    }

    const options = { location: body.location || "", description: MARK };
    let event;
    if (body.allDay) {
      // noon in Lima, so the date can't shift because of time zones
      event = calendar.createAllDayEvent(body.title, new Date(body.start + "T12:00:00-05:00"), options);
    } else {
      event = calendar.createEvent(body.title, new Date(body.start), new Date(body.end), options);
    }
    return reply({ ok: true, id: event.getId() });
  } catch (err) {
    return reply({ ok: false, error: String(err) });
  }
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
