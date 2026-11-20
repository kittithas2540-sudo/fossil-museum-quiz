# ระบบซิงก์สถิติผู้รับบริการ → Google Sheets (ทุก 15 นาที)

ระบบนี้อ่านข้อมูลจาก Firebase **ฝั่ง Google Apps Script เท่านั้น** แล้วเพิ่มหรือปรับปรุงแถวใน Google Sheets ด้วยคีย์ `PIN:FirebaseUID` เพื่อไม่ให้ข้อมูลห้องเดิมถูกนับซ้ำทุกครั้งที่ซิงก์

**ข้อจำกัดสำคัญ:** หากลบห้องเกมจาก Firebase ก่อนรอบซิงก์ ข้อมูลรอบนั้นจะไม่ถูกเก็บลง Sheets; ควรคงข้อมูลห้องไว้จนกว่าจะตรวจสอบว่าซิงก์สำเร็จ และตั้งนโยบายลบข้อมูลภายหลังอย่างเหมาะสม

## การตั้งค่าครั้งเดียว (ผู้ดูแลระบบ)

1. เปิดชีตสถิติ: https://docs.google.com/spreadsheets/d/1pHQ2XelcWUWn4hfbAw8UlOu-QiqXTuKgVgA2mb50Jr0/edit
2. เลือก **ส่วนขยาย → Apps Script** เพื่อสร้างโปรเจกต์ที่ผูกกับชีต
3. เปิดไฟล์ `apps-script/Code.gs` ใน Repository นี้ แล้วคัดลอกโค้ดไปวางใน Apps Script และบันทึก
4. ไปที่ Firebase Console → Project settings → Service accounts → Generate new private key (ต้องมีสิทธิ์ผู้ดูแล) ดาวน์โหลด JSON แล้วเก็บในที่ปลอดภัย **ห้ามอัปโหลดลง GitHub หรือส่งในแชต**
5. ใน Apps Script ไปที่ **Project Settings → Script Properties** และเพิ่ม:
   - `FIREBASE_SERVICE_ACCOUNT_JSON` = ข้อความ JSON ของ service account ทั้งก้อน (รวม private_key)
   - `FIREBASE_DATABASE_URL` = URL Realtime Database จาก Firebase Console (เช่น `https://fossil-quiz-default-rtdb.asia-southeast1.firebasedatabase.app`)
   - `SPREADSHEET_ID` = `1pHQ2XelcWUWn4hfbAw8UlOu-QiqXTuKgVgA2mb50Jr0`
6. กลับหน้า Editor เลือกฟังก์ชัน `setupFossilSync` → **Run** → อนุญาตสิทธิ์ให้สคริปต์เข้าถึง Sheets และเรียก Firebase ผ่าน HTTPS
7. ตรวจสอบแท็บ `ข้อมูลผู้เข้าร่วม` และหน้า **Executions** ใน Apps Script ว่าซิงก์สำเร็จ; จากนั้นสคริปต์จะทำงานทุก 15 นาทีโดยอัตโนมัติ

## ความปลอดภัยและความถูกต้อง

- **ไม่ต้อง Deploy เป็น Web App** และ **ห้ามเผยแพร่สคริปต์เป็น Anyone** เพราะระบบใช้ scheduled trigger เท่านั้น
- Service account มีสิทธิ์สูงมาก: จำกัดการเข้าถึง Apps Script ให้เฉพาะผู้ดูแล; หากรั่วไหลให้เพิกถอนคีย์ทันที
- ไม่ควรแชร์ Google Sheets ให้สาธารณะ เพราะมีชื่อที่ผู้เล่นกรอก
- ผู้เล่นไม่จำเป็นต้อง Login Google; หน้าเกมใช้ Firebase Anonymous Authentication เหมือนเดิม
- ต้องตรวจสอบ **Firebase Realtime Database Rules** แยกต่างหากก่อนใช้งานจริง: ระบบเกมปัจจุบันอ่าน `rooms/<PIN>` ซึ่งมีชื่อและรายละเอียดผู้เข้าร่วม การใช้ PIN ไม่ถือเป็นการปกป้องข้อมูลส่วนบุคคล
- ข้อมูลเก่าที่ไม่มี `visitorType` จะแสดงเป็น 'ไม่ระบุ'; รายชื่อในชีตอาจซ้ำเมื่อคนเดียวเล่นหลายห้อง
- หากมีการนำเข้า CSV เดิมด้วยตนเอง แถวเหล่านั้นไม่มีคีย์ในคอลัมน์ K จึงอาจถูกนำเข้าอีกครั้ง ควรใช้ชีตใหม่หรือจัดการข้อมูลซ้ำก่อนเปิดการซิงก์
- สำหรับข้อมูลจำนวนมาก ควรเปลี่ยนจากการอ่าน `rooms.json` ทั้งหมดเป็นการซิงก์แบบ incremental เพื่อประหยัดโควตา

## คอลัมน์

A PIN · B วันที่ไทย · C ชื่อที่แสดง · D ประเภทผู้รับบริการ · E โรงเรียน/หน่วยงาน · F ระดับการศึกษา · G สถานะ · H คะแนน · I เวลาเข้าร่วม ISO · J เวลาเล่นจบ ISO · K คีย์สำหรับป้องกันซ้ำ

หากต้องการตรวจสอบเวลาซิงก์ล่าสุด ให้ดู Script Properties: `LAST_SYNC_AT` และ `LAST_SYNC_COUNT`
