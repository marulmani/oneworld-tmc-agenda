/**
 * OneWorld Toastmasters Club – Members' Portal backend (Google Apps Script)
 *
 * Paste this whole file into Extensions → Apps Script of the club's Google Sheet.
 * Then follow SETUP.md: run setup() once, set CLIENT_ID, deploy as a Web app.
 *
 * Data lives in the sheet's tabs (Members, Meetings, Bookings, Pathways, Log),
 * so the exco can always read or fix it directly in Google Sheets.
 */

// ============ 1. SETTINGS (edit these) ============
const CONFIG = {
  // OAuth Client ID from Google Cloud Console (see SETUP.md step 3)
  CLIENT_ID: 'PASTE_YOUR_CLIENT_ID.apps.googleusercontent.com',
  // Officers with these offices (Members tab, "office" column) can manage meetings and book for others.
  ADMIN_OFFICES: ['President', 'VP Education', 'Secretary'],
  TIMEZONE: 'Asia/Kuala_Lumpur',
  UPCOMING_COUNT: 8,   // meetings shown for booking
  PAST_COUNT: 6        // past meetings kept in role history
};

// Meeting roles. ids must match the public website's agenda (index.html).
const ROLE_DEFS = [
  { id: 'saa', title: 'Sergeant at Arms', group: 'leaders' },
  { id: 'president', title: 'Presiding Officer', group: 'leaders' },
  { id: 'tmod', title: 'Toastmaster of the Day', group: 'leaders' },
  { id: 'ttm', title: 'Table Topics Master', group: 'leaders' },
  { id: 'ge', title: 'General Evaluator', group: 'leaders' },
  { id: 'sp1', title: 'Speaker 1', group: 'speakers', speech: true },
  { id: 'sp2', title: 'Speaker 2', group: 'speakers', speech: true },
  { id: 'sp3', title: 'Speaker 3', group: 'speakers', speech: true },
  { id: 'tte', title: 'Table Topics Evaluator', group: 'evaluators' },
  { id: 'ev1', title: 'Evaluator 1', group: 'evaluators', evaluates: 'sp1' },
  { id: 'ev2', title: 'Evaluator 2', group: 'evaluators', evaluates: 'sp2' },
  { id: 'ev3', title: 'Evaluator 3', group: 'evaluators', evaluates: 'sp3' },
  { id: 'timer', title: 'Timer', group: 'functionaries' },
  { id: 'ah', title: 'Ah-Counter', group: 'functionaries' },
  { id: 'gram', title: 'Grammarian', group: 'functionaries' }
];

const SHEETS = {
  Members: ['email', 'name', 'designation', 'office', 'access', 'active', 'joined', 'phone'],
  Meetings: ['no', 'date', 'start', 'end', 'theme', 'wod', 'wodSay', 'wodMeaning', 'format', 'zoomUrl', 'zoomId', 'zoomPass', 'status', 'notes'],
  Bookings: ['meetingNo', 'roleId', 'email', 'name', 'speechTitle', 'path', 'level', 'project', 'timeRange', 'updatedAt', 'updatedBy'],
  Pathways: ['email', 'name', 'path', 'level', 'currentProject', 'completed', 'targetDate', 'updatedAt'],
  Log: ['timestamp', 'email', 'action', 'details']
};

// ============ 2. ONE-TIME SETUP (run from the Apps Script editor) ============
function setup() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  Object.keys(SHEETS).forEach(name => {
    let sh = ss.getSheetByName(name);
    if (!sh) sh = ss.insertSheet(name);
    const headers = SHEETS[name];
    sh.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight('bold').setBackground('#004165').setFontColor('#ffffff');
    sh.setFrozenRows(1);
    // Keep everything as plain text so dates/times are not auto-converted
    sh.getRange(2, 1, Math.max(sh.getMaxRows() - 1, 1), headers.length).setNumberFormat('@');
  });
  const me = (Session.getActiveUser().getEmail() || '').toLowerCase();
  if (me && !readTable('Members').some(m => m.email === me)) {
    appendObj('Members', { email: me, name: 'Club Admin', designation: '', office: 'President', access: 'admin', active: 'yes', joined: today_() });
  }
  if (!readTable('Meetings').length) {
    appendObj('Meetings', { no: '362', date: '2026-11-12', start: '19:45', end: '21:45', theme: 'Dare to be Different', wod: 'Bold', wodSay: '/BOHLD/',
      wodMeaning: 'Confident and courageous.', format: 'Hybrid', status: 'upcoming' });
  }
  // Makes Google ask for the "connect to an external service" permission now; sign-in checks need it.
  UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo', { muteHttpExceptions: true });
  Logger.log('Setup done. Add members in the Members tab (email, name, office, access=member/admin, active=yes).');
}

// ============ 3. WEB ENTRY POINTS ============
function doGet(e) {
  const action = e && e.parameter && e.parameter.action;
  if (action === 'public') return json_({ ok: true, ...publicData_() });
  return json_({ ok: true, service: 'OneWorld TMC portal API' });
}

function doPost(e) {
  try {
    const body = JSON.parse((e && e.postData && e.postData.contents) || '{}');
    const action = String(body.action || '');
    if (action === 'public') return json_({ ok: true, ...publicData_() });
    const user = auth_(body.token);
    const handlers = { bootstrap: bootstrap_, book: book_, cancel: cancel_, savePathway: savePathway_, saveMeeting: saveMeeting_ };
    if (!handlers[action]) throw new Error('UNKNOWN_ACTION');
    return json_({ ok: true, ...handlers[action](user, body) });
  } catch (err) {
    return json_({ ok: false, error: String(err && err.message || err) });
  }
}

function json_(obj) {
  return ContentService.createTextOutput(JSON.stringify(obj)).setMimeType(ContentService.MimeType.JSON);
}

// ============ 4. SIGN-IN (Google ID token → club member) ============
function auth_(token) {
  if (!token) throw new Error('SIGN_IN_REQUIRED');
  const cache = CacheService.getScriptCache();
  const key = 'tok_' + Utilities.base64EncodeWebSafe(Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, token)).slice(0, 40);
  let email = cache.get(key);
  if (!email) {
    const res = UrlFetchApp.fetch('https://oauth2.googleapis.com/tokeninfo?id_token=' + encodeURIComponent(token), { muteHttpExceptions: true });
    if (res.getResponseCode() !== 200) throw new Error('TOKEN_EXPIRED');
    const info = JSON.parse(res.getContentText());
    if (info.aud !== CONFIG.CLIENT_ID) throw new Error('BAD_CLIENT');
    if (String(info.email_verified) !== 'true') throw new Error('EMAIL_NOT_VERIFIED');
    if (Number(info.exp) * 1000 < Date.now()) throw new Error('TOKEN_EXPIRED');
    email = String(info.email).toLowerCase();
    cache.put(key, email, Math.max(60, Math.min(1800, Number(info.exp) - Math.floor(Date.now() / 1000))));
  }
  const m = readTable('Members').find(r => r.email === email && String(r.active || 'yes').toLowerCase() !== 'no');
  if (!m) throw new Error('NOT_MEMBER:' + email);
  m.isAdmin = String(m.access).toLowerCase() === 'admin' || CONFIG.ADMIN_OFFICES.indexOf(m.office) >= 0;
  return m;
}

// ============ 5. ACTIONS ============
function publicData_() {
  const meetings = sortedMeetings_();
  const upcoming = meetings.filter(m => m.status !== 'done' && m.date >= today_());
  const next = upcoming[0] || null;
  let roles = [];
  if (next) {
    const bookings = readTable('Bookings').filter(b => b.meetingNo === next.no);
    roles = ROLE_DEFS.map(r => {
      const b = bookings.find(x => x.roleId === r.id);
      return { id: r.id, title: r.title, group: r.group, name: b ? b.name : '',
        speech: b ? b.speechTitle : '', project: b ? [b.path, b.level ? 'Level ' + b.level : '', b.project].filter(String).join(' • ') : '', time: b ? b.timeRange : '' };
    });
  }
  const pub = m => ({ no: m.no, date: m.date, start: m.start, end: m.end, theme: m.theme, wod: m.wod, wodSay: m.wodSay, wodMeaning: m.wodMeaning,
    format: m.format, zoomUrl: m.zoomUrl, zoomId: m.zoomId, zoomPass: m.zoomPass });
  return { meeting: next ? pub(next) : null, roles, upcoming: upcoming.slice(0, 4).map(m => ({ no: m.no, date: m.date, theme: m.theme })) };
}

function bootstrap_(user) {
  const meetings = sortedMeetings_();
  const t = today_();
  const upcoming = meetings.filter(m => m.status !== 'done' && m.date >= t).slice(0, CONFIG.UPCOMING_COUNT);
  const past = meetings.filter(m => m.status === 'done' || m.date < t).slice(-CONFIG.PAST_COUNT);
  const nos = upcoming.concat(past).map(m => m.no);
  const members = readTable('Members').filter(m => String(m.active || 'yes').toLowerCase() !== 'no');
  const bookings = readTable('Bookings').filter(b => nos.indexOf(b.meetingNo) >= 0).map(b => ({
    meetingNo: b.meetingNo, roleId: b.roleId, name: b.name, speechTitle: b.speechTitle, path: b.path, level: b.level,
    project: b.project, timeRange: b.timeRange, mine: b.email === user.email, email: user.isAdmin ? b.email : undefined
  }));
  const pathways = readTable('Pathways').map(p => ({ name: p.name, path: p.path, level: p.level, currentProject: p.currentProject,
    completed: p.completed, targetDate: p.targetDate, updatedAt: p.updatedAt, mine: p.email === user.email, email: user.isAdmin ? p.email : undefined }));
  return {
    me: { name: user.name, designation: user.designation, office: user.office, isAdmin: user.isAdmin, email: user.email },
    roleDefs: ROLE_DEFS,
    members: members.map(m => ({ name: m.name, designation: m.designation, office: m.office, isMe: m.email === user.email, email: user.isAdmin ? m.email : undefined })),
    upcoming, past, bookings, pathways
  };
}

function book_(user, p) {
  return withLock_(() => {
    const meeting = readTable('Meetings').find(m => m.no === String(p.meetingNo));
    if (!meeting) throw new Error('NO_SUCH_MEETING');
    if (meeting.status === 'done' || meeting.date < today_()) throw new Error('MEETING_CLOSED');
    const role = ROLE_DEFS.find(r => r.id === p.roleId);
    if (!role) throw new Error('NO_SUCH_ROLE');
    let target = user;
    if (p.forEmail && p.forEmail.toLowerCase() !== user.email) {
      if (!user.isAdmin) throw new Error('ADMIN_ONLY');
      target = readTable('Members').find(m => m.email === String(p.forEmail).toLowerCase());
      if (!target) throw new Error('NO_SUCH_MEMBER');
    }
    const existing = readTable('Bookings').find(b => b.meetingNo === meeting.no && b.roleId === role.id);
    if (existing && existing.email !== target.email && !user.isAdmin) throw new Error('ROLE_TAKEN');
    const rec = { meetingNo: meeting.no, roleId: role.id, email: target.email, name: displayName_(target), speechTitle: '', path: '', level: '', project: '', timeRange: '',
      updatedAt: new Date().toISOString(), updatedBy: user.email };
    if (role.speech) {
      rec.path = clean_(p.path); rec.level = clean_(p.level); rec.project = clean_(p.project);
      rec.speechTitle = clean_(p.speechTitle) || 'TBA'; rec.timeRange = clean_(p.timeRange) || '5–7 min';
      if (!rec.path || !rec.project) throw new Error('SPEECH_DETAILS_REQUIRED');
      // Keep the speaker's Pathways record in step with what they are presenting
      const pw = readTable('Pathways').find(x => x.email === target.email);
      const upd = { email: target.email, name: rec.name, path: rec.path, level: rec.level, currentProject: rec.project, updatedAt: new Date().toISOString() };
      if (pw) updateRow_('Pathways', pw._row, { ...pw, ...upd }); else appendObj('Pathways', { ...upd, completed: '', targetDate: '' });
    }
    if (existing) updateRow_('Bookings', existing._row, rec); else appendObj('Bookings', rec);
    log_(user.email, 'book', `#${meeting.no} ${role.id} → ${target.email}`);
    return bootstrap_(user);
  });
}

function cancel_(user, p) {
  return withLock_(() => {
    const b = readTable('Bookings').find(x => x.meetingNo === String(p.meetingNo) && x.roleId === p.roleId);
    if (!b) return bootstrap_(user);
    if (b.email !== user.email && !user.isAdmin) throw new Error('NOT_YOUR_BOOKING');
    SpreadsheetApp.getActiveSpreadsheet().getSheetByName('Bookings').deleteRow(b._row);
    log_(user.email, 'cancel', `#${b.meetingNo} ${b.roleId} (${b.email})`);
    return bootstrap_(user);
  });
}

function savePathway_(user, p) {
  return withLock_(() => {
    let target = user;
    if (p.forEmail && p.forEmail.toLowerCase() !== user.email) {
      if (!user.isAdmin) throw new Error('ADMIN_ONLY');
      target = readTable('Members').find(m => m.email === String(p.forEmail).toLowerCase());
      if (!target) throw new Error('NO_SUCH_MEMBER');
    }
    const rec = { email: target.email, name: displayName_(target), path: clean_(p.path), level: clean_(p.level), currentProject: clean_(p.currentProject),
      completed: clean_(p.completed, 4000), targetDate: clean_(p.targetDate), updatedAt: new Date().toISOString() };
    const pw = readTable('Pathways').find(x => x.email === target.email);
    if (pw) updateRow_('Pathways', pw._row, rec); else appendObj('Pathways', rec);
    log_(user.email, 'pathway', target.email);
    return bootstrap_(user);
  });
}

function saveMeeting_(user, p) {
  if (!user.isAdmin) throw new Error('ADMIN_ONLY');
  return withLock_(() => {
    const m = p.meeting || {};
    const rec = {};
    SHEETS.Meetings.forEach(k => { rec[k] = clean_(m[k], 600); });
    if (!rec.no || !/^\d{4}-\d{2}-\d{2}$/.test(rec.date)) throw new Error('MEETING_NO_AND_DATE_REQUIRED');
    rec.status = rec.status || 'upcoming';
    const existing = readTable('Meetings').find(x => x.no === rec.no);
    if (existing) updateRow_('Meetings', existing._row, rec); else appendObj('Meetings', rec);
    log_(user.email, 'meeting', '#' + rec.no);
    return bootstrap_(user);
  });
}

// ============ 6. SHEET HELPERS ============
function readTable(name) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  if (!sh || sh.getLastRow() < 2) return [];
  const headers = SHEETS[name];
  const values = sh.getRange(2, 1, sh.getLastRow() - 1, headers.length).getValues();
  return values.map((row, i) => {
    const o = { _row: i + 2 };
    headers.forEach((h, j) => { o[h] = normCell_(h, row[j]); });
    if (o.email) o.email = String(o.email).trim().toLowerCase();
    return o;
  }).filter(o => headers.some(h => o[h] !== ''));
}
function normCell_(h, v) {
  if (v instanceof Date) {
    if (h === 'start' || h === 'end') return Utilities.formatDate(v, CONFIG.TIMEZONE, 'HH:mm');
    return Utilities.formatDate(v, CONFIG.TIMEZONE, 'yyyy-MM-dd');
  }
  return v === null || v === undefined ? '' : String(v).trim();
}
function appendObj(name, obj) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  sh.appendRow(SHEETS[name].map(h => obj[h] == null ? '' : String(obj[h])));
}
function updateRow_(name, row, obj) {
  const sh = SpreadsheetApp.getActiveSpreadsheet().getSheetByName(name);
  sh.getRange(row, 1, 1, SHEETS[name].length).setValues([SHEETS[name].map(h => obj[h] == null ? '' : String(obj[h]))]);
}
function sortedMeetings_() {
  return readTable('Meetings').sort((a, b) => (a.date + a.start).localeCompare(b.date + b.start));
}
function withLock_(fn) {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(15000)) throw new Error('BUSY_TRY_AGAIN');
  try { return fn(); } finally { lock.releaseLock(); }
}
function log_(email, action, details) { appendObj('Log', { timestamp: new Date().toISOString(), email, action, details }); }
function today_() { return Utilities.formatDate(new Date(), CONFIG.TIMEZONE, 'yyyy-MM-dd'); }
function displayName_(m) { return [m.name, m.designation].filter(String).join(', '); }
// Trim, cap length, and stop spreadsheet formula injection (cells starting with = + - @)
function clean_(v, max) {
  let s = String(v == null ? '' : v).trim().slice(0, max || 300);
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  return s;
}
