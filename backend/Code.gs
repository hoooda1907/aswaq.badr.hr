/**
 * نظام بصمة الحضور والانصراف - Google Apps Script
 * الصق الكود ده في: الشيت > Extensions > Apps Script
 */
const TZ = Session.getScriptTimeZone();
const DAYS = ['الأحد', 'الاثنين', 'الثلاثاء', 'الأربعاء', 'الخميس', 'الجمعة', 'السبت'];
const SHEETS = {
  Branches: ['id', 'name', 'lat', 'lng', 'radius'],
  Shifts: ['id', 'name', 'start', 'end', 'hours', 'grace'],
  Employees: ['code', 'name', 'password', 'branchId', 'shiftId', 'salary', 'role', 'deviceId', 'active'],
  Emails: ['email'],
  Settings: ['key', 'value'],
  Punches: ['ms', 'date', 'time', 'code', 'type', 'lat', 'lng', 'branchId', 'dist']
};

/* ===================== تجهيز أولي (شغّلها مرة واحدة) ===================== */
function setup() {
  const s = ss();
  Object.keys(SHEETS).forEach(n => {
    const sh = s.getSheetByName(n) || s.insertSheet(n);
    const w = SHEETS[n].length;
    sh.getRange(1, 1, 1, w).setValues([SHEETS[n]]).setFontWeight('bold');
    sh.getRange(2, 1, sh.getMaxRows() - 1, w).setNumberFormat('@');
    sh.setFrozenRows(1);
  });
  if (!readAll('Settings').length) {
    [['weekly_off', '5'], ['overtime_rate', '1.5'], ['month_days', '30']].forEach(r => appendText('Settings', r));
  }
  if (!readAll('Shifts').length) appendText('Shifts', ['S1', 'صباحي', '09:00', '17:00', '8', '15']);
  if (!readAll('Branches').length) appendText('Branches', ['B1', 'الفرع الرئيسي', '30.0444', '31.2357', '100']);
  if (!readAll('Employees').length) appendText('Employees', ['admin', 'المدير', hash('admin123'), '', '', '0', 'admin', '', '1']);
  setupTriggers();
}

function setupTriggers() {
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'dailyJob').forEach(t => ScriptApp.deleteTrigger(t));
  ScriptApp.newTrigger('dailyJob').timeBased().everyDays(1).atHour(6).create();
}

/* ===================== أدوات الشيت ===================== */
function ss() { return SpreadsheetApp.getActiveSpreadsheet(); }
function ds(d) { return Utilities.formatDate(d, TZ, 'yyyy-MM-dd'); }
function rd(n) { return Math.round(n * 100) / 100; }
function hm(t) { return t ? String(t).substring(0, 5) : ''; }
function hash(p) {
  return Utilities.computeDigest(Utilities.DigestAlgorithm.SHA_256, String(p), Utilities.Charset.UTF_8)
    .map(b => ('0' + (b & 0xff).toString(16)).slice(-2)).join('');
}
function readAll(name) {
  const sh = ss().getSheetByName(name);
  if (!sh) return [];
  const v = sh.getDataRange().getDisplayValues();
  const h = v[0];
  return v.slice(1).filter(r => r[0] !== '').map(r => { const o = {}; h.forEach((k, i) => o[k] = r[i]); return o; });
}
function appendText(name, arr) {
  const sh = ss().getSheetByName(name);
  const r = sh.getLastRow() + 1;
  const rg = sh.getRange(r, 1, 1, arr.length);
  rg.setNumberFormat('@');
  rg.setValues([arr.map(String)]);
}
function upsertRow(name, obj) {
  const sh = ss().getSheetByName(name), H = SHEETS[name];
  const data = sh.getDataRange().getDisplayValues();
  const arr = H.map(h => obj[h] == null ? '' : String(obj[h]));
  for (let i = 1; i < data.length; i++) {
    if (data[i][0] === arr[0]) {
      const rg = sh.getRange(i + 1, 1, 1, H.length);
      rg.setNumberFormat('@'); rg.setValues([arr]); return;
    }
  }
  appendText(name, arr);
}
function deleteRow(name, key) {
  const sh = ss().getSheetByName(name);
  const data = sh.getDataRange().getDisplayValues();
  for (let i = data.length - 1; i >= 1; i--) if (data[i][0] === String(key)) sh.deleteRow(i + 1);
}
function getCfg() { const c = {}; readAll('Settings').forEach(r => c[r.key] = r.value); return c; }
function recipients() { return readAll('Emails').map(r => r.email).filter(String); }

/* ===================== الـ API ===================== */
function doPost(e) {
  let out;
  try { out = route(JSON.parse(e.postData.contents)); }
  catch (err) { out = { ok: false, error: String(err.message || err) }; }
  return ContentService.createTextOutput(JSON.stringify(out)).setMimeType(ContentService.MimeType.JSON);
}
function doGet() { return ContentService.createTextOutput('HR Attendance API OK'); }

function auth(req) {
  const e = readAll('Employees').find(x => x.code === String(req.code).trim() && x.active !== '0');
  if (!e || e.password !== hash(req.password)) throw new Error('الكود أو كلمة المرور غير صحيحة');
  if (e.role !== 'admin') {
    if (!req.deviceId) throw new Error('تعذر تحديد الجهاز');
    if (!e.deviceId) { e.deviceId = req.deviceId; upsertRow('Employees', e); }
    else if (e.deviceId !== req.deviceId) throw new Error('هذا الحساب مرتبط بجهاز آخر، راجع الـ HR');
  }
  return e;
}

function route(req) {
  const emp = auth(req);
  switch (req.action) {
    case 'login': return { ok: true, name: emp.name, role: emp.role, code: emp.code, open: lastTwo(emp.code).open };
    case 'punch': return punch(emp, req);
    case 'month': return Object.assign({ ok: true }, empMonth(emp, req.ym));
  }
  if (emp.role !== 'admin') throw new Error('غير مصرح');
  switch (req.action) {
    case 'adminList': {
      checkSheet(req.sheet);
      const rows = readAll(req.sheet);
      if (req.sheet === 'Employees') rows.forEach(r => r.password = '');
      return { ok: true, headers: SHEETS[req.sheet], rows: rows };
    }
    case 'adminSave': {
      checkSheet(req.sheet);
      const row = req.row;
      if (req.sheet === 'Employees') {
        const old = readAll('Employees').find(x => x.code === row.code);
        if (row.password) row.password = hash(row.password);
        else if (old) row.password = old.password;
        else throw new Error('اكتب كلمة مرور للموظف الجديد');
        if (!row.active) row.active = '1';
        if (!row.role) row.role = 'employee';
      }
      if (req.sheet === 'Branches' && (isNaN(+row.lat) || isNaN(+row.lng) || isNaN(+row.radius))) throw new Error('الإحداثيات والنطاق لازم تكون أرقام');
      upsertRow(req.sheet, row);
      return { ok: true };
    }
    case 'adminDelete':
      checkSheet(req.sheet);
      if (req.sheet === 'Employees' && String(req.key) === emp.code) throw new Error('لا يمكن حذف حسابك');
      deleteRow(req.sheet, req.key);
      return { ok: true };
    case 'sendDaily': sendDaily(req.date); return { ok: true, message: 'تم إرسال التقرير اليومي' };
    case 'sendMonthly': sendMonthly(req.ym); return { ok: true, message: 'تم إرسال التقرير الشهري والمرتبات' };
  }
  throw new Error('طلب غير معروف');
}
function checkSheet(n) { if (!SHEETS[n] || n === 'Punches') throw new Error('شيت غير مسموح'); }

/* ===================== البصمة ===================== */
function haversine(a, b, c, d) {
  const R = 6371000, r = x => x * Math.PI / 180;
  const dLat = r(c - a), dLng = r(d - b);
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(r(a)) * Math.cos(r(c)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}
function lastTwo(code) {
  const all = readAll('Punches');
  let last = null, lastIn = null;
  for (let i = all.length - 1; i >= 0; i--) {
    if (all[i].code !== code) continue;
    if (!last) last = all[i];
    if (all[i].type === 'IN') { lastIn = all[i]; break; }
  }
  const open = !!(last && last.type === 'IN' && Date.now() - (+last.ms) < 20 * 36e5);
  return { last, lastIn, open };
}
function punch(emp, req) {
  if (req.mocked) throw new Error('تم اكتشاف موقع وهمي (Fake GPS)');
  const br = readAll('Branches').find(b => b.id === emp.branchId);
  if (!br) throw new Error('لم يتم تحديد فرع لك، راجع الـ HR');
  const dist = haversine(+req.lat, +req.lng, +br.lat, +br.lng);
  if (!(dist <= +br.radius)) throw new Error('خطأ: خارج نطاق مكان العمل');
  const lock = LockService.getScriptLock();
  lock.waitLock(15000);
  try {
    const now = new Date(), t = lastTwo(emp.code);
    if (req.type === 'IN') {
      if (t.open) throw new Error('سجلت حضور بالفعل');
      if (t.last && t.last.type === 'OUT' && t.lastIn && t.lastIn.date === ds(now)) throw new Error('سجلت حضورك وانصرافك اليوم بالفعل');
    } else if (!t.open) throw new Error('لا يوجد حضور مسجل لتسجل انصراف');
    const time = Utilities.formatDate(now, TZ, 'HH:mm:ss');
    appendText('Punches', [now.getTime(), ds(now), time, emp.code, req.type, req.lat, req.lng, br.id, Math.round(dist)]);
    return { ok: true, open: req.type === 'IN', message: (req.type === 'IN' ? 'تم تسجيل الحضور ' : 'تم تسجيل الانصراف ') + hm(time) };
  } finally { lock.releaseLock(); }
}

/* ===================== الحسابات ===================== */
function pairs(list) {
  const out = []; let cur = null;
  list.forEach(p => {
    if (p.type === 'IN') {
      if (cur) out.push(cur);
      cur = { date: p.date, inMs: +p.ms, inTime: p.time, outMs: null, outTime: '' };
    } else if (cur) { cur.outMs = +p.ms; cur.outTime = p.time; out.push(cur); cur = null; }
  });
  if (cur) out.push(cur);
  return out;
}
function toMin(t) { const p = String(t).split(':'); return (+p[0]) * 60 + (+p[1] || 0); }
function shiftOf(emp, shifts) { return shifts.find(s => s.id === emp.shiftId) || { start: '09:00', end: '17:00', hours: '8', grace: '0' }; }
function stats(r, shift) {
  const req = +shift.hours || 8, grace = +shift.grace || 0;
  let late = toMin(r.inTime) - toMin(shift.start) - grace;
  if (late < 0 || late > 600) late = 0;
  const notes = [];
  if (late > 0) notes.push('تأخير ' + late + ' د');
  if (!r.outMs) { notes.push('لم يسجل انصراف'); return { worked: 0, late, over: 0, deficit: 0, note: notes.join(' | ') }; }
  const worked = (r.outMs - r.inMs) / 36e5, defMin = (req - worked) * 60;
  const over = Math.max(0, worked - req), deficit = defMin > grace ? defMin / 60 : 0;
  if (over >= 0.01) notes.push('إضافي ' + rd(over) + ' س');
  if (deficit > 0) notes.push('نقص ' + rd(deficit) + ' س');
  return { worked, late, over, deficit, note: notes.join(' | ') };
}
function monthStats(shift, recs, ym, cfg) {
  const [y, m] = ym.split('-').map(Number);
  const last = new Date(y, m, 0).getDate(), today = ds(new Date());
  const off = String(cfg.weekly_off || '').split(',').map(s => s.trim());
  const byDate = {};
  recs.forEach(r => { if (!byDate[r.date]) byDate[r.date] = r; });
  const days = []; let present = 0, absent = 0, hours = 0, late = 0, over = 0, deficit = 0;
  for (let d = 1; d <= last; d++) {
    const dt = new Date(y, m - 1, d, 12), date = ds(dt);
    if (date > today) break;
    const dow = DAYS[dt.getDay()], r = byDate[date];
    if (r) {
      const s = stats(r, shift);
      present++; hours += s.worked; late += s.late; over += s.over; deficit += s.deficit;
      days.push({ date, dow, status: 'present', in: hm(r.inTime), out: hm(r.outTime), worked: rd(s.worked), late: s.late, over: rd(s.over), note: s.note });
    } else if (off.indexOf(String(dt.getDay())) >= 0) {
      days.push({ date, dow, status: 'off', in: '', out: '', worked: 0, late: 0, over: 0, note: 'إجازة أسبوعية' });
    } else if (date < today) {
      absent++;
      days.push({ date, dow, status: 'absent', in: '', out: '', worked: 0, late: 0, over: 0, note: 'غياب' });
    }
  }
  return { days, present, absent, hours: rd(hours), late, over: rd(over), deficit: rd(deficit) };
}
function empMonth(emp, ym) {
  if (!/^\d{4}-\d{2}$/.test(ym || '')) throw new Error('شهر غير صحيح');
  const mine = readAll('Punches').filter(p => p.code === emp.code).sort((a, b) => +a.ms - +b.ms);
  return monthStats(shiftOf(emp, readAll('Shifts')), pairs(mine), ym, getCfg());
}
function loadData() {
  const emps = readAll('Employees').filter(e => e.role !== 'admin' && e.active !== '0');
  const byCode = {};
  readAll('Punches').forEach(p => (byCode[p.code] = byCode[p.code] || []).push(p));
  const recs = {};
  Object.keys(byCode).forEach(c => recs[c] = pairs(byCode[c].sort((a, b) => +a.ms - +b.ms)));
  return { emps, recs, branches: readAll('Branches'), shifts: readAll('Shifts'), cfg: getCfg() };
}
function payRow(emp, shift, st, cfg) {
  const salary = +emp.salary || 0, daily = salary / (+cfg.month_days || 30), hourly = daily / (+shift.hours || 8);
  const absentDed = st.absent * daily, lateDed = st.deficit * hourly, ot = st.over * hourly * (+cfg.overtime_rate || 1);
  return { salary, absentDed: rd(absentDed), lateDed: rd(lateDed), ot: rd(ot), net: rd(salary - absentDed - lateDed + ot) };
}

/* ===================== التقارير ===================== */
function dailyJob() {
  const now = new Date(), y = new Date(now.getTime() - 864e5);
  sendDaily(ds(y));
  if (Number(Utilities.formatDate(now, TZ, 'd')) === 1) sendMonthly(Utilities.formatDate(y, TZ, 'yyyy-MM'));
}
function htmlTable(head, rows) {
  const th = head.map(h => `<th style="border:1px solid #ccc;padding:6px;background:#e8f1f0">${h}</th>`).join('');
  const body = rows.map(r => '<tr>' + r.map(c => {
    const s = String(c), red = /لم يسجل|غائب/.test(s) ? ';color:#c00;font-weight:bold' : '';
    return `<td style="border:1px solid #ccc;padding:6px${red}">${s}</td>`;
  }).join('') + '</tr>').join('');
  return `<table style="border-collapse:collapse;direction:rtl;font-family:Arial"><tr>${th}</tr>${body}</table>`;
}
function makeXlsx(fileName, sheets) {
  const t = SpreadsheetApp.create(fileName);
  let first = true;
  Object.keys(sheets).forEach(title => {
    const sh = first ? t.getSheets()[0] : t.insertSheet();
    first = false;
    sh.setName(title.replace(/[\[\]\*\?\/\\:]/g, '').substring(0, 90) || 'Sheet');
    const rows = sheets[title];
    sh.getRange(1, 1, rows.length, rows[0].length).setValues(rows);
    sh.getRange(1, 1, 1, rows[0].length).setFontWeight('bold');
    sh.setRightToLeft(true);
  });
  SpreadsheetApp.flush();
  const blob = UrlFetchApp.fetch('https://docs.google.com/spreadsheets/d/' + t.getId() + '/export?format=xlsx',
    { headers: { Authorization: 'Bearer ' + ScriptApp.getOAuthToken() } }).getBlob().setName(fileName + '.xlsx');
  DriveApp.getFileById(t.getId()).setTrashed(true);
  return blob;
}
function sendDaily(date) {
  const to = recipients();
  if (!to.length) throw new Error('أضف إيميل مستلم أولاً');
  const D = loadData(), [y, m, d] = date.split('-').map(Number), dow = new Date(y, m - 1, d, 12).getDay();
  const isOff = String(D.cfg.weekly_off || '').split(',').map(s => s.trim()).indexOf(String(dow)) >= 0;
  const head = ['الكود', 'الاسم', 'الحضور', 'الانصراف', 'ساعات العمل', 'تأخير/إضافي'];
  const groups = {};
  D.emps.forEach(e => {
    const br = D.branches.find(b => b.id === e.branchId), bn = br ? br.name : 'بدون فرع';
    (groups[bn] = groups[bn] || []).push(e);
  });
  let html = `<div dir="rtl" style="font-family:Arial"><h2>تقرير الحضور - ${date} (${DAYS[dow]})</h2>`;
  const sheets = {}; let present = 0, absentN = 0;
  Object.keys(groups).forEach(bn => {
    const rows = [], gone = [];
    groups[bn].forEach(e => {
      const r = (D.recs[e.code] || []).find(x => x.date === date);
      if (r) {
        const s = stats(r, shiftOf(e, D.shifts)); present++;
        rows.push([e.code, e.name, hm(r.inTime), hm(r.outTime) || '—', r.outMs ? rd(s.worked) : '—', s.note]);
      } else if (!isOff) { gone.push([e.code, e.name, 'غائب', '', '', '']); absentN++; }
    });
    const all = rows.concat(gone);
    html += `<h3>فرع: ${bn}</h3>` + (all.length ? htmlTable(head, all) : '<p>لا توجد بيانات</p>');
    sheets[bn] = [head].concat(all.length ? all : [['', '', '', '', '', '']]);
  });
  html += `<p>حاضر: ${present} | غائب: ${absentN}${isOff ? ' (إجازة أسبوعية)' : ''}</p></div>`;
  MailApp.sendEmail({ to: to.join(','), subject: 'تقرير الحضور اليومي - ' + date, htmlBody: html,
    name: 'نظام الحضور', attachments: [makeXlsx('حضور-' + date, sheets)] });
}
function sendMonthly(ym) {
  const to = recipients();
  if (!to.length) throw new Error('أضف إيميل مستلم أولاً');
  const D = loadData();
  const att = [['الاسم', 'الكود', 'الفرع', 'التاريخ', 'اليوم', 'الحضور', 'الانصراف', 'ساعات العمل', 'تأخير (د)', 'إضافي (س)', 'ملاحظات']];
  const pay = [['الكود', 'الاسم', 'الفرع', 'الراتب الأساسي', 'أيام الحضور', 'أيام الغياب', 'إجمالي الساعات', 'تأخير (د)', 'إضافي (س)', 'خصم الغياب', 'خصم النقص', 'قيمة الإضافي', 'الصافي']];
  let total = 0;
  D.emps.forEach(e => {
    const br = D.branches.find(b => b.id === e.branchId), bn = br ? br.name : '', sh = shiftOf(e, D.shifts);
    const st = monthStats(sh, D.recs[e.code] || [], ym, D.cfg), p = payRow(e, sh, st, D.cfg);
    st.days.forEach(x => att.push([e.name, e.code, bn, x.date, x.dow, x.in, x.out, x.worked, x.late, x.over, x.note]));
    pay.push([e.code, e.name, bn, p.salary, st.present, st.absent, st.hours, st.late, st.over, p.absentDed, p.lateDed, p.ot, p.net]);
    total += p.net;
  });
  const html = `<div dir="rtl" style="font-family:Arial"><h2>تقفيل شهر ${ym}</h2><p>عدد الموظفين: ${D.emps.length}</p><p>إجمالي المرتبات الصافية: ${rd(total)}</p><p>التفاصيل في الملف المرفق (شيت الحضور + شيت المرتبات).</p></div>`;
  MailApp.sendEmail({ to: to.join(','), subject: 'تقفيل الشهر ' + ym, htmlBody: html, name: 'نظام الحضور',
    attachments: [makeXlsx('تقفيل-' + ym, { 'الحضور': att, 'المرتبات': pay })] });
}
