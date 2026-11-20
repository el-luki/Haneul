/**
 * Haneul: TKS mentor outreach through your Gmail.
 *
 * Runs inside YOUR personal Google account (Google Apps Script, free), like calendar-script.
 * The bot never gets your Google password. It only accepts requests that include the secret below,
 * and it can do exactly three things:
 *   - "send": send ONE email you approved in the Haneul app (the bot never sends unapproved mail)
 *   - "overview": read recent mail from/to the contacts you track in Outreach (to spot replies)
 *   - "ping": check that it's connected
 *
 * Setup (once):
 *   1. script.google.com, signed in to your PERSONAL Google account → New project, name it "Haneul Gmail".
 *   2. Replace everything in Code.gs with this file. Paste GMAIL_SCRIPT_SECRET (from
 *      telegram-calendar-bot/.env on your PC) between the quotes below.
 *   3. Deploy → New deployment → type "Web app". Execute as: Me · Who has access: Anyone.
 *   4. Authorize (Google warns the app is unverified because you wrote it yourself:
 *      Advanced → Go to project → Allow). It asks for Gmail access: that's this script only.
 *   5. Copy the Web app URL (ends in /exec) and send it to Claude.
 */

const SECRET = "PASTE_GMAIL_SCRIPT_SECRET_HERE";
const MAX_ADDRESSES = 60;

function doPost(e) {
  try {
    const body = JSON.parse(e.postData.contents);
    if (!SECRET || SECRET.indexOf("PASTE_") === 0 || body.secret !== SECRET) return reply({ ok: false, error: "unauthorized" });

    if (body.action === "ping") return reply({ ok: true });

    if (body.action === "send") {
      if (!body.to || !body.subject || !body.body) return reply({ ok: false, error: "to, subject and body are needed" });
      // A follow-up goes into the same conversation, so they see the first email under it.
      if (body.threadId) {
        try {
          const thread = GmailApp.getThreadById(body.threadId);
          if (thread) {
            thread.reply(body.body, { subject: body.subject });
            return reply({ ok: true, threadId: thread.getId() });
          }
        } catch (err) {} // thread gone: send a new email instead
      }
      GmailApp.sendEmail(body.to, body.subject, body.body);
      // find the thread we just created, so follow-ups can use it
      Utilities.sleep(1500);
      const sent = GmailApp.search('in:sent to:' + body.to + ' subject:"' + String(body.subject).replace(/"/g, "") + '" newer_than:1d', 0, 1);
      return reply({ ok: true, threadId: sent.length ? sent[0].getId() : "" });
    }

    if (body.action === "overview") {
      const addresses = (body.addresses || []).filter(function (a) { return /^[^\s@]+@[^\s@]+$/.test(a); }).slice(0, MAX_ADDRESSES);
      if (!addresses.length) return reply({ ok: true, messages: [] });
      const days = Math.min(Math.max(Number(body.days) || 30, 1), 90);
      const who = addresses.join(" OR ");
      const threads = GmailApp.search("(from:(" + who + ") OR to:(" + who + ")) newer_than:" + days + "d", 0, 30);
      const messages = [];
      threads.forEach(function (t) {
        t.getMessages().slice(-3).forEach(function (m) {
          messages.push({
            id: m.getId(), threadId: t.getId(), from: m.getFrom(), to: m.getTo(), subject: m.getSubject(),
            snippet: m.getPlainBody().replace(/\s+/g, " ").slice(0, 300), date: m.getDate().toISOString(),
          });
        });
      });
      messages.sort(function (a, b) { return a.date < b.date ? 1 : -1; });
      return reply({ ok: true, messages: messages.slice(0, 60) });
    }

    return reply({ ok: false, error: "unknown action" });
  } catch (err) {
    return reply({ ok: false, error: String(err) });
  }
}

function reply(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}
