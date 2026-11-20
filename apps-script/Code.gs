/**
 * FOSSIL MUSEUM QUIZ → Google Sheets
 * Server-side scheduled synchronization (every 5 minutes). NEVER place service-account credentials in GitHub.
 * Setup: see docs/GOOGLE_SHEETS_SYNC.md
 */
const SHEET_NAME = 'ข้อมูลผู้เข้าร่วม';
const COLUMNS = 11;
const ARCHIVE_SHEET = 'คลังข้อมูล';
const EXCLUSION_SHEET = 'รายการไม่ซิงก์';

function setupFossilSync() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('FIREBASE_SERVICE_ACCOUNT_JSON')) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON in Script Properties');
  if (!props.getProperty('FIREBASE_DATABASE_URL')) throw new Error('Missing FIREBASE_DATABASE_URL');
  if (!props.getProperty('SPREADSHEET_ID')) throw new Error('Missing SPREADSHEET_ID');
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'syncFossilVisitors').forEach(trigger => ScriptApp.deleteTrigger(trigger));
  ScriptApp.newTrigger('syncFossilVisitors').timeBased().everyMinutes(5).create();
  syncFossilVisitors();
}

function firebaseAccessToken_() {
  const account = JSON.parse(PropertiesService.getScriptProperties().getProperty('FIREBASE_SERVICE_ACCOUNT_JSON'));
  if (!account.client_email || !account.private_key) throw new Error('Invalid service account');
  const now = Math.floor(Date.now() / 1000);
  const encode = obj => Utilities.base64EncodeWebSafe(JSON.stringify(obj)).replace(/=+$/,'');
  const unsigned = encode({alg:'RS256',typ:'JWT'}) + '.' + encode({
    iss:account.client_email, sub:account.client_email,
    aud:'https://oauth2.googleapis.com/token',
    scope:'https://www.googleapis.com/auth/firebase.database https://www.googleapis.com/auth/userinfo.email',
    iat:now, exp:now+3600
  });
  const signature = Utilities.base64EncodeWebSafe(Utilities.computeRsaSha256Signature(unsigned,account.private_key)).replace(/=+$/,'');
  const response = UrlFetchApp.fetch('https://oauth2.googleapis.com/token',{
    method:'post',muteHttpExceptions:true,
    payload:{grant_type:'urn:ietf:params:oauth:grant-type:jwt-bearer',assertion:unsigned+'.'+signature}
  });
  if (response.getResponseCode() !== 200) throw new Error('Firebase OAuth failed: HTTP '+response.getResponseCode());
  return JSON.parse(response.getContentText()).access_token;
}

function syncFossilVisitors() {
  const lock = LockService.getScriptLock();
  if (!lock.tryLock(10000)) return;
  try {
    const props = PropertiesService.getScriptProperties();
    const spreadsheet = SpreadsheetApp.openById(props.getProperty('SPREADSHEET_ID'));
    const sheet = spreadsheet.getSheetByName(SHEET_NAME);
    if (!sheet) throw new Error('Missing sheet: '+SHEET_NAME);
    const base = props.getProperty('FIREBASE_DATABASE_URL').replace(/\/+$/,'');
    if (!/^https:\/\/[a-z0-9.-]+\.firebasedatabase\.app$/i.test(base) &&
        !/^https:\/\/[a-z0-9.-]+\.firebaseio\.com$/i.test(base)) throw new Error('Invalid Firebase database URL');
    const response = UrlFetchApp.fetch(base+'/rooms.json?access_token='+encodeURIComponent(firebaseAccessToken_()),{muteHttpExceptions:true});
    if (response.getResponseCode() !== 200) throw new Error('Firebase read failed: HTTP '+response.getResponseCode());
    const rooms = JSON.parse(response.getContentText()) || {};
    const last = sheet.getLastRow();
    const existing = last>1 ? sheet.getRange(2,11,last-1,1).getValues().flat() : [];
    const excludedSheet = ensureAdminSheet_(spreadsheet,EXCLUSION_SHEET,['คีย์ PIN:UID','เหตุผล','วันที่จัดการ']);
    const excluded = new Set(excludedSheet.getLastRow()>1 ? excludedSheet.getRange(2,1,excludedSheet.getLastRow()-1,1).getValues().flat().filter(Boolean).map(String) : []);
    const positions = new Map();
    existing.forEach((key,i)=>{if(key) positions.set(String(key),i+2)});
    const updates = [], additions = [];
    const thaiDate = ms => ms ? Utilities.formatDate(new Date(ms),'Asia/Bangkok','dd/MM/yyyy') : '';
    const iso = ms => ms ? new Date(ms).toISOString() : '';
    for (const [pin,room] of Object.entries(rooms)) {
      if (!/^\d{6}$/.test(pin) || !room || typeof room !== 'object') continue;
      for (const [uid,p] of Object.entries(room.players||{})) {
        if (!p || typeof p !== 'object' || !p.joinedAt) continue;
        const key=pin+':'+uid;
        if (excluded.has(key)) continue;
        const row=[
          pin,thaiDate(p.joinedAt),String(p.name||'').slice(0,40),
          String(p.visitorType||'ไม่ระบุ').slice(0,80),
          String(p.organization||'').slice(0,100),
          String(p.educationLevel||'').slice(0,80),
          p.completedAt?'เล่นจบ':'เข้าร่วม',
          Number(p.score)||0,iso(p.joinedAt),iso(p.completedAt),key
        ];
        if (positions.has(key)) updates.push({index:positions.get(key),row});
        else {additions.push(row);positions.set(key,-1)}
      }
    }
    // Update only changed rows; excluded records never reappear.

    for (const {index,row} of updates) {
      const range=sheet.getRange(index,1,1,COLUMNS);
      const old=range.getValues()[0].map(String);
      if (row.some((value,i)=>String(value)!==old[i])) range.setValues([row]);
    }
    if (additions.length) sheet.getRange(sheet.getLastRow()+1,1,additions.length,COLUMNS).setValues(additions);
    props.setProperty('LAST_SYNC_AT',new Date().toISOString());
    props.setProperty('LAST_SYNC_COUNT',String(updates.length+additions.length));
    console.log('Fossil sync complete: '+updates.length+' existing; '+additions.length+' new');
  } finally { lock.releaseLock(); }
}

/**
 * Admin operations: run only from the Apps Script editor as the authorized owner.
 * Select rows in the 'ข้อมูลผู้เข้าร่วม' tab before running a selected-row action.
 * Never run these functions on an arbitrary active sheet.
 */
function ensureAdminSheet_(ss,name,headers) {
  let sheet=ss.getSheetByName(name);
  if (!sheet) {sheet=ss.insertSheet(name);sheet.appendRow(headers);sheet.setFrozenRows(1);}
  return sheet;
}

function adminContext_() {
  const props=PropertiesService.getScriptProperties();
  const ss=SpreadsheetApp.openById(props.getProperty('SPREADSHEET_ID'));
  const sheet=ss.getSheetByName(SHEET_NAME);
  if (!sheet) throw new Error('ไม่พบแท็บข้อมูลผู้เข้าร่วม');
  return {ss,sheet};
}

function selectedRecords_() {
  const {ss,sheet}=adminContext_();
  const active=SpreadsheetApp.getActiveSpreadsheet();
  if (!active || active.getId()!==ss.getId() || active.getActiveSheet().getSheetId()!==sheet.getSheetId())
    throw new Error('กรุณาเปิดแท็บข้อมูลผู้เข้าร่วม แล้วเลือกแถวที่จะจัดการ');
  const selection=active.getActiveRange();
  if (!selection || selection.getRow()<=1) throw new Error('เลือกเฉพาะแถวข้อมูลตั้งแต่แถว 2 เป็นต้นไป');
  const first=selection.getRow(), count=selection.getNumRows();
  const rows=sheet.getRange(first,1,count,COLUMNS).getValues();
  const result=rows.map((values,i)=>({number:first+i,values,key:String(values[10]||'')}));
  if (result.some(x=>!/^\\d{6}:[^:]+$/.test(x.key)))
    throw new Error('มีแถวที่ไม่มีคีย์ซิงก์ PIN:UID กรุณาเลือกเฉพาะข้อมูลที่ซิงก์อัตโนมัติ');
  return {ss,sheet,records:result};
}

function archiveRecords_(ss,records,reason) {
  const archive=ensureAdminSheet_(ss,ARCHIVE_SHEET,
    ['PIN','วันที่เข้าร่วม','ชื่อที่แสดง','ประเภทผู้รับบริการ','โรงเรียน/หน่วยงาน','ระดับการศึกษา','สถานะ','คะแนน','เวลาเข้าร่วม ISO','เวลาเล่นจบ ISO','คีย์ซิงก์','วันที่จัดเก็บ','เหตุผล']);
  const existing=archive.getLastRow()>1 ? new Set(archive.getRange(2,11,archive.getLastRow()-1,1).getValues().flat().map(String)) : new Set();
  const newRows=records.filter(r=>!existing.has(r.key)).map(r=>[...r.values,new Date(),reason]);
  if(newRows.length) archive.getRange(archive.getLastRow()+1,1,newRows.length,13).setValues(newRows);
}

function excludeRecords_(ss,records,reason) {
  const sheet=ensureAdminSheet_(ss,EXCLUSION_SHEET,['คีย์ PIN:UID','เหตุผล','วันที่จัดการ']);
  const existing=sheet.getLastRow()>1 ? new Set(sheet.getRange(2,1,sheet.getLastRow()-1,1).getValues().flat().map(String)) : new Set();
  const additions=records.filter(r=>!existing.has(r.key)).map(r=>[r.key,reason,new Date()]);
  if(additions.length) sheet.getRange(sheet.getLastRow()+1,1,additions.length,3).setValues(additions);
}

function removeRows_(sheet,records) {
  records.map(r=>r.number).sort((a,b)=>b-a).forEach(row=>sheet.deleteRow(row));
}

/** Archive selected records, then remove them from live statistics; Firebase remains unchanged. */
function archiveSelectedVisitors() {
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(10000)) throw new Error('ระบบกำลังซิงก์อยู่ ลองอีกครั้ง');
  try {
    const {ss,sheet,records}=selectedRecords_();
    archiveRecords_(ss,records,'เก็บเข้าคลังโดยผู้ดูแล');
    excludeRecords_(ss,records,'เก็บเข้าคลัง ไม่ซิงก์กลับ');
    removeRows_(sheet,records);
    console.log('Archived '+records.length+' visitor rows');
  } finally {lock.releaseLock();}
}

/** Exclude and remove selected rows from statistics; does not delete Firebase data. */
function removeSelectedVisitors() {
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(10000)) throw new Error('ระบบกำลังซิงก์อยู่ ลองอีกครั้ง');
  try {
    const {ss,sheet,records}=selectedRecords_();
    excludeRecords_(ss,records,'ลบออกจากสถิติ ไม่ซิงก์กลับ');
    removeRows_(sheet,records);
    console.log('Removed '+records.length+' visitor rows from statistics');
  } finally {lock.releaseLock();}
}

/** Archive all current records, then reset live dashboard to zero without re-importing old Firebase rows. */
function resetTestStatistics() {
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(10000)) throw new Error('ระบบกำลังซิงก์อยู่ ลองอีกครั้ง');
  try {
    const {ss,sheet}=adminContext_();
    const count=sheet.getLastRow()-1;
    if(count<=0) {console.log('No records to reset');return;}
    const records=sheet.getRange(2,1,count,COLUMNS).getValues().map((values,i)=>({number:i+2,values,key:String(values[10]||'')}));
    if(records.some(r=>!/^\\d{6}:[^:]+$/.test(r.key)))
      throw new Error('มีข้อมูลนำเข้าด้วยมือที่ไม่มีคีย์ซิงก์ กรุณาจัดการแถวเหล่านั้นแยกต่างหาก');
    archiveRecords_(ss,records,'ล้างสถิติทดสอบ');
    excludeRecords_(ss,records,'ล้างสถิติทดสอบ ไม่ซิงก์กลับ');
    sheet.deleteRows(2,count);
    console.log('Reset '+count+' test rows; all archived and excluded from re-import');
  } finally {lock.releaseLock();}
}

/**
 * Permanently delete selected records from Firebase and live statistics.
 * No archive is created, to honor a permanent-deletion request.
 * Requires selecting the target rows and running this explicit admin-only function.
 */
function permanentlyDeleteSelectedVisitors() {
  const lock=LockService.getScriptLock();
  if(!lock.tryLock(10000)) throw new Error('ระบบกำลังซิงก์อยู่ ลองอีกครั้ง');
  try {
    const {ss,sheet,records}=selectedRecords_();
    const props=PropertiesService.getScriptProperties();
    const base=props.getProperty('FIREBASE_DATABASE_URL').replace(/\\/+$/,'');
    const token=firebaseAccessToken_();
    // Exclude first so a failed/deferred sync cannot re-add removed rows.
    excludeRecords_(ss,records,'ลบถาวรโดยผู้ดูแล');
    for (const record of records) {
      const [pin,uid]=record.key.split(':');
      const response=UrlFetchApp.fetch(base+'/rooms/'+encodeURIComponent(pin)+'/players/'+encodeURIComponent(uid)+'.json?access_token='+encodeURIComponent(token),{method:'delete',muteHttpExceptions:true});
      if(response.getResponseCode()<200||response.getResponseCode()>=300)
        throw new Error('Firebase DELETE failed for '+record.key+': HTTP '+response.getResponseCode()+' (รายการที่ลบสำเร็จก่อนหน้าไม่สามารถย้อนคืนได้)');
    }
    removeRows_(sheet,records);
    console.log('Permanently deleted '+records.length+' player records from Firebase and Sheets');
  } finally {lock.releaseLock();}
}
