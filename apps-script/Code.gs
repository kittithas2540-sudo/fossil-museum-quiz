/**
 * FOSSIL MUSEUM QUIZ → Google Sheets
 * Server-side scheduled synchronization (every 5 minutes). NEVER place service-account credentials in GitHub.
 * Setup: see docs/GOOGLE_SHEETS_SYNC.md
 */
const SHEET_NAME = 'ข้อมูลผู้เข้าร่วม';
const COLUMNS = 11;

function setupFossilSync() {
  const props = PropertiesService.getScriptProperties();
  if (!props.getProperty('FIREBASE_SERVICE_ACCOUNT_JSON')) throw new Error('Missing FIREBASE_SERVICE_ACCOUNT_JSON in Script Properties');
  if (!props.getProperty('FIREBASE_DATABASE_URL')) throw new Error('Missing FIREBASE_DATABASE_URL');
  if (!props.getProperty('SPREADSHEET_ID')) throw new Error('Missing SPREADSHEET_ID');
  ScriptApp.getProjectTriggers().filter(t => t.getHandlerFunction() === 'syncFossilVisitors').forEach(ScriptApp.deleteTrigger);
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
    // Update only changed rows; avoid rewriting entire sheet every 15 minutes.
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
