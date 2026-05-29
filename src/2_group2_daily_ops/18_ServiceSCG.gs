/**
 * VERSION: 5.4.002
 * FILE: 18_ServiceSCG.gs
 * LMDS V5.4 — SCG API Service (Group 2 Commander)
 * ===================================================
 * PURPOSE:
 *   ดึงข้อมูลการจัดส่งจาก SCG API → เขียนลงตารางงานประจำวัน
 *   แล้วเรียก Module 17 จับคู่พิกัด พร้อมสร้างสรุปเจ้าของสินค้า/Shipment
 *   เป็น Commander ของ Group 2 (Daily Ops)
 * ===================================================
 * CHANGELOG:
 *   v5.4.002 (2026-05-27) — Security & Reliability Hardening:
 *     - [FIX BUG-004] fetchDataFromSCGJWD: wrap JSON.parse ใน try-catch + validate structure
 *     - [FIX BUG-005] Cookie ย้ายไป PropertiesService (SCG_COOKIE) — รองรับ migration จาก B1 อัตโนมัติ
 *     - [ADD     ]  setupScgCookie / clearScgCookie / showScgCookieStatus เมนูจัดการ Cookie
 *     - [FIX BUG-006] buildOwnerSummary / buildShipmentSummary: ใช้ SHEET.OWNER_SUMMARY / SHEET.SHIPMENT_SUM แทน hardcoded Thai
 *     - [FIX BUG-008] tryLock(10000) → waitLock(LOCK_TIMEOUT_MS) ป้องกัน concurrent execution
 *     - [FIX BUG-012] clearAllSCGSheets_UI: เพิ่ม confirmation dialog ก่อนลบข้อมูล
 *     - [FIX BUG-014] fetchWithRetry_: validate HTTP 200 + JSON structure + response body length
 *     - [FIX BUG-018] summary builders: ใช้ getLastColumn() แทน hardcoded 6/7
 *     - [FIX BUG-020] summary timestamps: ใช้ Utilities.formatDate + Session.getScriptTimeZone
 *     - [FIX BUG-022] console.log/error/warn → logInfo/logError/logWarn (เข้า SYS_LOG)
 *     - [FIX NEW-013] summary builders: ใช้ safeUiAlert_ แทน getUi().alert ตรงๆ (trigger-safe)
 *     - [FIX BUG-010] เพิ่ม validate row.length === SCHEMA[DAILY_JOB].length ก่อน setValues
 *   v5.4.002-previous (2026-05-26) — Single Writer Fix:
 *     - [REMOVE] fetchDataFromSCGJWD: ลบ populateAliasFromSCGRawData_() — Group 2 ห้ามเขียน M_ALIAS
 *     - [FIX] Hardcode index: แทนที่ r[28], r[14], r[16], r[2], r[9] ด้วย DATA_IDX.*
 *   v5.4.001 (2026-05-24) — Single Writer Pattern:
 *     - [ADD] fetchDataFromSCGJWD: เรียก populateAliasFromSCGRawData_ หลัง applyMasterCoordinatesToDailyJob
 *   v5.4.000 (2026-05-23):
 *     - [UPGRADE] Version bump to 5.4.000
 *   v5.2.012:
 *     - [REVERT] กู้คืน fetchDataFromSCGJWD() เป็นแบบ Batch ตามข้อกำหนดของผู้ใช้
 *     - [PRESERVE] รักษาการเรียก runLookupEnrichment() ของ Module 17
 * ===================================================
 * DEPENDENCIES:
 *   REQUIRES (Load Order):
 *     - 01_Config.gs          (SHEET.*, SCG_CONFIG, APP_CONST, DATA_IDX)
 *     - 02_Schema.gs          (SCHEMA[SHEET.DAILY_JOB])
 *     - 03_SetupSheets.gs     (logInfo, logWarn, logError)
 *     - 14_Utils.gs           (safeUiAlert_)
 *   CALLS (Invokes):
 *     - applyMasterCoordinatesToDailyJob() → 18_ServiceSCG.gs (self — calls Module 17)
 *     - runLookupEnrichment()              → 17_SearchService.gs
 *     - [REMOVED v5.4.002] populateAliasFromSCGRawData_() → ย้ายไปเป็น Migration/Admin เท่านั้น
 *   EXPORTS TO:
 *     - 00_App.gs             (fetchDataFromSCGJWD, applyMasterCoordinatesToDailyJob,
 *                              clearAllSCGSheets_UI, setupScgCookie, clearScgCookie, showScgCookieStatus)
 *   SHEETS ACCESSED:
 *     - SHEET.DAILY_JOB       (Read+Write: SCG API data + aggregated columns)
 *     - SHEET.INPUT           (Read: Shipment numbers + LEGACY Cookie migration)
 *     - SHEET.EMPLOYEE        (Read: Employee data)
 *     - SHEET.OWNER_SUMMARY   (Write: สรุปเจ้าของสินค้า)
 *     - SHEET.SHIPMENT_SUM    (Write: สรุป_Shipment)
 *   PROPERTIES SERVICE:
 *     - SCG_COOKIE            (Read+Write: SCG session cookie — ย้ายจาก B1)
 *     - SCG_API_URL           (Read: API endpoint override — optional)
 * ===================================================
 * ARCHITECTURE:
 *   ┌─────────────────────────────────────────────────────────────┐
 *   │  18_ServiceSCG.gs (Group 2 Commander — SCG Data Pipeline)   │
 *   │  ├── fetchDataFromSCGJWD() — SCG API → Daily Job Sheet     │
 *   │  │   ├── 1. โหลด Cookie จาก PropertiesService (fallback B1)  │
 *   │  │   ├── 2. โหลด ShipmentNos จากชีต Input                   │
 *   │  │   ├── 3. เรียก SCG API (fetchWithRetry_ + validation)    │
 *   │  │   ├── 4. แปลง JSON → Flat rows + aggregate               │
 *   │  │   ├── 5. applyMasterCoordinatesToDailyJob() → Module 17  │
 *   │  │   ├── 6. buildOwnerSummary()                              │
 *   │  │   └── 7. buildShipmentSummary()                           │
 *   │  ├── fetchWithRetry_() — HTTP retry + content validation     │
 *   │  ├── checkIsEPOD() — E-POD eligibility per owner            │
 *   │  ├── buildOwnerSummary() — สรุปเจ้าของสินค้า               │
 *   │  ├── buildShipmentSummary() — สรุป_Shipment                 │
 *   │  ├── clearAllSCGSheets_UI() — ล้างข้อมูลทั้งหมด (มี confirm)│
 *   │  ├── clearDailyJobLatLng() — ล้างเฉพาะพิกัด                 │
 *   │  └── setupScgCookie / clearScgCookie / showScgCookieStatus   │
 *   └─────────────────────────────────────────────────────────────┘
 * ===================================================
 */

// ============================================================
// SECTION 0: SCG Cookie Management — [NEW v5.4.002 BUG-005 FIX]
// ============================================================

/**
 * getScgCookie_ — ดึง SCG Cookie จาก PropertiesService
 * [FIX BUG-005] เดิมเก็บใน cell B1 (plaintext) → ใครก็อ่านได้ → session hijacking risk
 * [BACKWARD-COMPAT] ถ้ายังไม่มีใน PropertiesService แต่มีใน B1 → migrate อัตโนมัติ
 * @return {string} cookie string (trimmed)
 * @throws ถ้าไม่พบ Cookie ทั้งใน Properties + B1
 */
function getScgCookie_() {
  const props = PropertiesService.getScriptProperties();
  let cookie = String(props.getProperty('SCG_COOKIE') || '').trim();

  if (cookie) return cookie;

  // [MIGRATION] ลองอ่าน Cookie เก่าจาก B1 แล้วย้ายเข้า PropertiesService
  try {
    const ss = SpreadsheetApp.getActiveSpreadsheet();
    const inputSheet = ss.getSheetByName(SCG_CONFIG.SHEET_INPUT);
    if (inputSheet) {
      const legacy = String(inputSheet.getRange(SCG_CONFIG.COOKIE_CELL).getValue() || '').trim();
      if (legacy) {
        props.setProperty('SCG_COOKIE', legacy);
        // ลบออกจากชีตเพื่อความปลอดภัย (เก็บเฉพาะใน Properties)
        try { inputSheet.getRange(SCG_CONFIG.COOKIE_CELL).clearContent(); } catch (clearErr) {
          logWarn('ServiceSCG', `ไม่สามารถล้าง Cookie จาก ${SCG_CONFIG.COOKIE_CELL}: ${clearErr.message}`);
        }
        logInfo('ServiceSCG', `[MIGRATION] ย้าย Cookie จาก ${SCG_CONFIG.COOKIE_CELL} → PropertiesService สำเร็จ`);
        cookie = legacy;
      }
    }
  } catch (migErr) {
    logWarn('ServiceSCG', `Cookie migration ล้มเหลว: ${migErr.message}`);
  }

  if (!cookie) {
    throw new Error(
      '❌ ยังไม่ได้ตั้งค่า SCG Cookie\n' +
      'กรุณาเปิดเมนู: 🟦 กลุ่ม 2 → ⚙️ ตั้งค่า SCG Cookie\n' +
      'หรือวาง Cookie ในช่อง ' + SCG_CONFIG.COOKIE_CELL + ' ของชีต ' + SCG_CONFIG.SHEET_INPUT + ' (จะถูกย้ายอัตโนมัติ)'
    );
  }
  return cookie;
}

/**
 * setupScgCookie — UI menu สำหรับตั้งค่า Cookie แบบปลอดภัย
 * [NEW BUG-005] ใช้ ui.prompt เพื่อให้ผู้ใช้พิมพ์ Cookie โดยตรง ไม่เก็บลงชีต
 */
function setupScgCookie() {
  const ui = SpreadsheetApp.getUi();
  const resp = ui.prompt(
    '⚙️ ตั้งค่า SCG Cookie',
    'วาง SCG session cookie:\n(จะถูกบันทึกใน PropertiesService — ปลอดภัยกว่าเซลล์ B1)',
    ui.ButtonSet.OK_CANCEL
  );
  if (resp.getSelectedButton() !== ui.Button.OK) return;

  const cookie = String(resp.getResponseText() || '').trim();
  if (!cookie || cookie.length < 10) {
    ui.alert('❌ Cookie ไม่ถูกต้อง (สั้นเกินไป)');
    return;
  }

  PropertiesService.getScriptProperties().setProperty('SCG_COOKIE', cookie);
  logInfo('ServiceSCG', `ตั้งค่า SCG_COOKIE สำเร็จ (ยาว ${cookie.length} ตัวอักษร)`);
  ui.alert('✅ บันทึก SCG Cookie เรียบร้อย\n(หากเคยมี Cookie ใน ' + SCG_CONFIG.COOKIE_CELL + ' จะถูกล้างอัตโนมัติเมื่อใช้งานครั้งถัดไป)');
}

/**
 * clearScgCookie — ลบ Cookie ออกจาก PropertiesService
 */
function clearScgCookie() {
  const ui = SpreadsheetApp.getUi();
  const resp = ui.alert(
    '⚠️ ยืนยันการลบ SCG Cookie?',
    'ระบบจะลบ Cookie ที่บันทึกไว้ทั้งหมด ต้องตั้งค่าใหม่ก่อนใช้งานครั้งถัดไป\nดำเนินการต่อ?',
    ui.ButtonSet.YES_NO
  );
  if (resp !== ui.Button.YES) return;

  PropertiesService.getScriptProperties().deleteProperty('SCG_COOKIE');
  logInfo('ServiceSCG', 'ลบ SCG_COOKIE สำเร็จ');
  ui.alert('✅ ลบ SCG Cookie เรียบร้อยแล้ว');
}

/**
 * showScgCookieStatus — ดูสถานะ Cookie (ไม่แสดงค่าเต็ม — เฉพาะ length + prefix สั้นๆ)
 */
function showScgCookieStatus() {
  const ui = SpreadsheetApp.getUi();
  const cookie = String(PropertiesService.getScriptProperties().getProperty('SCG_COOKIE') || '').trim();
  if (!cookie) {
    ui.alert('ℹ️ ยังไม่ได้ตั้งค่า SCG Cookie\nกรุณาเปิดเมนู: 🟦 กลุ่ม 2 → ⚙️ ตั้งค่า SCG Cookie');
    return;
  }
  const masked = cookie.substring(0, 8) + '…' + cookie.substring(cookie.length - 4) +
                 ` (ยาว ${cookie.length} ตัวอักษร)`;
  ui.alert(`🔐 SCG Cookie สถานะ: บันทึกแล้ว\nMasked: ${masked}`);
}

// ============================================================
// SECTION 1: fetchDataFromSCGJWD — ดึงข้อมูลจาก SCG API (Batch)
// ============================================================

function fetchDataFromSCGJWD() {
  const ss = SpreadsheetApp.getActiveSpreadsheet();
  const ui = SpreadsheetApp.getUi();

  // [FIX BUG-008] เปลี่ยน tryLock(10000) → waitLock(LOCK_TIMEOUT_MS)
  // tryLock(10000) จะปล่อยให้รันคู่กันหลังรอ 10 วินาที → data corruption
  // waitLock จะ block จนกว่า lock จะว่าง = mutual exclusion ที่ถูกต้อง
  const lock = LockService.getScriptLock();
  try {
    lock.waitLock(APP_CONST.LOCK_TIMEOUT_MS);
  } catch (lockErr) {
    ui.alert('⚠️ ระบบคิวทำงาน',
             'มีผู้ใช้งานอื่นกำลังโหลดข้อมูล Shipment อยู่ กรุณารอสักครู่แล้วลองใหม่',
             ui.ButtonSet.OK);
    return;
  }

  try {
    const inputSheet = ss.getSheetByName(SCG_CONFIG.SHEET_INPUT);
    const dataSheet  = ss.getSheetByName(SCG_CONFIG.SHEET_DATA);
    if (!inputSheet || !dataSheet) throw new Error("CRITICAL: ไม่พบชีต Input หรือ Data");

    // [FIX BUG-005] โหลด Cookie จาก PropertiesService (จะ migrate จาก B1 อัตโนมัติถ้ายังไม่มี)
    const cookie = getScgCookie_();

    const lastRow = inputSheet.getLastRow();
    if (lastRow < SCG_CONFIG.INPUT_START_ROW) throw new Error("ℹ️ ไม่พบเลข Shipment ในชีต Input");

    const shipmentNumbers = inputSheet
      .getRange(SCG_CONFIG.INPUT_START_ROW, 1, lastRow - SCG_CONFIG.INPUT_START_ROW + 1, 1)
      .getValues().flat().map(r => String(r || '').trim()).filter(Boolean);

    if (shipmentNumbers.length === 0) throw new Error("ℹ️ รายการ Shipment ว่างเปล่า");

    // เขียนเลข Shipment ต่อกันคั่นด้วยจุลภาคลงในช่อง B3 (สำหรับอ้างอิง/copy)
    const shipmentString = shipmentNumbers.join(',');
    inputSheet.getRange(SCG_CONFIG.SHIPMENT_STRING_CELL).setValue(shipmentString).setHorizontalAlignment("left");

    const payload = {
      DeliveryDateFrom: '', DeliveryDateTo: '', TenderDateFrom: '', TenderDateTo: '',
      CarrierCode: '', CustomerCode: '', OriginCodes: '', ShipmentNos: shipmentString
    };

    const options = {
      method: 'post', payload: payload, muteHttpExceptions: true, headers: { cookie: cookie }
    };

    ss.toast("กำลังเชื่อมต่อ SCG Server...", "System", 10);
    logInfo('ServiceSCG', `Fetching data for ${shipmentNumbers.length} shipments`);
    const responseText = fetchWithRetry_(SCG_CONFIG.API_URL, options, (APP_CONST.MAX_RETRIES || 3));

    // [FIX BUG-004] wrap JSON.parse + validate structure
    let json;
    try {
      json = JSON.parse(responseText);
    } catch (parseErr) {
      throw new Error(
        'SCG API ตอบกลับมาแต่ไม่ใช่ JSON ที่ถูกต้อง — Cookie อาจหมดอายุ หรือ API ส่งหน้า HTML/Redirect กลับมา\n' +
        'รายละเอียด: ' + parseErr.message + '\n' +
        'Body (200 chars): ' + String(responseText).substring(0, 200)
      );
    }
    if (!json || typeof json !== 'object') {
      throw new Error('SCG API ส่ง response ที่ไม่ใช่ object: ' + String(responseText).substring(0, 200));
    }
    if (!Array.isArray(json.data)) {
      const apiErrMsg = json.error || json.message || JSON.stringify(json).substring(0, 200);
      throw new Error('SCG API response ไม่มี field "data" เป็น array: ' + apiErrMsg);
    }
    const shipments = json.data;

    if (shipments.length === 0) throw new Error("API Return Success แต่ไม่พบข้อมูล Shipment (Data Empty)");

    ss.toast("กำลังแปลงข้อมูล " + shipments.length + " Shipments...", "Processing", 5);
    const allFlatData = [];
    let runningRow = 2;

    shipments.forEach(shipment => {
      const destSet = new Set();
      (shipment.DeliveryNotes || []).forEach(n => { if (n.ShipToName) destSet.add(n.ShipToName); });
      const destListStr = Array.from(destSet).join(", ");

      (shipment.DeliveryNotes || []).forEach(note => {
        (note.Items || []).forEach(item => {
          const dailyJobId = note.PurchaseOrder + "-" + runningRow;
          const row = [
            dailyJobId,
            note.PlanDelivery ? new Date(note.PlanDelivery) : null,
            String(note.PurchaseOrder || ''),
            String(shipment.ShipmentNo || ''),
            shipment.DriverName || '',
            shipment.TruckLicense || '',
            String(shipment.CarrierCode || ''),
            shipment.CarrierName || '',
            String(note.SoldToCode || ''),
            note.SoldToName || '',
            note.ShipToName || '',
            note.ShipToAddress || '',
            (note.ShipToLatitude != null && note.ShipToLongitude != null) ? (note.ShipToLatitude + ", " + note.ShipToLongitude) : '',
            item.MaterialName || '',
            item.ItemQuantity || 0,
            item.QuantityUnit || '',
            item.ItemWeight || 0,
            String(note.DeliveryNo || ''),
            destSet.size,
            destListStr,
            "รอสแกน",
            "ยังไม่ได้ส่ง",
            "",
            0, 0, 0,
            "",
            "",
            (shipment.ShipmentNo || '') + "|" + (note.ShipToName || '')
          ];
          allFlatData.push(row);
          runningRow++;
        });
      });
    });

    // [FIX v5.4.002] แทนที่ hardcode index ด้วย DATA_IDX.*
    const shopAgg = {};
    allFlatData.forEach(r => {
      const key = r[DATA_IDX.SHOP_KEY];
      if (!shopAgg[key]) shopAgg[key] = { qty: 0, weight: 0, invoices: new Set(), epod: 0 };
      shopAgg[key].qty += Number(r[DATA_IDX.QTY]) || 0;
      shopAgg[key].weight += Number(r[DATA_IDX.WEIGHT]) || 0;
      shopAgg[key].invoices.add(r[DATA_IDX.INVOICE_NO]);
      if (checkIsEPOD(r[DATA_IDX.SOLD_TO_NAME], r[DATA_IDX.INVOICE_NO])) shopAgg[key].epod++;
    });

    allFlatData.forEach(r => {
      const agg = shopAgg[r[DATA_IDX.SHOP_KEY]];
      const scanInv = agg.invoices.size - agg.epod;
      r[DATA_IDX.TOT_QTY] = agg.qty;
      r[DATA_IDX.TOT_WEIGHT] = Number(agg.weight.toFixed(2));
      r[DATA_IDX.SCAN_INV] = scanInv;
      r[DATA_IDX.OWNER_LABEL] = `${r[DATA_IDX.SOLD_TO_NAME]} / รวม ${scanInv} บิล`;
    });

    const headers = [
      "ID_งานประจำวัน", "PlanDelivery", "InvoiceNo", "ShipmentNo", "DriverName",
      "TruckLicense", "CarrierCode", "CarrierName", "SoldToCode", "SoldToName",
      "ShipToName", "ShipToAddress", "LatLong_SCG", "MaterialName", "ItemQuantity",
      "QuantityUnit", "ItemWeight", "DeliveryNo", "จำนวนปลายทาง_System", "รายชื่อปลายทาง_System",
      "ScanStatus", "DeliveryStatus", "Email พนักงาน",
      "จำนวนสินค้ารวมของร้านนี้", "น้ำหนักสินค้ารวมของร้านนี้", "จำนวน_Invoice_ที่ต้องสแกน",
      "LatLong_Actual", "ชื่อเจ้าของสินค้า_Invoice_ที่ต้องสแกน", "ShopKey"
    ];

    // [FIX BUG-010] validate row.length ตรงกับ SCHEMA ก่อน setValues
    const schemaCols = (SCHEMA[SHEET.DAILY_JOB] && SCHEMA[SHEET.DAILY_JOB].length) || headers.length;
    if (allFlatData.length > 0 && allFlatData[0].length !== schemaCols) {
      throw new Error(
        `Row column count mismatch: row has ${allFlatData[0].length} cols but SCHEMA[${SHEET.DAILY_JOB}] requires ${schemaCols}. ` +
        'ตรวจสอบ DATA_IDX และ SCHEMA ใน 01_Config.gs / 02_Schema.gs ให้ตรงกัน'
      );
    }

    dataSheet.clear();
    dataSheet.getRange(1, 1, 1, headers.length).setValues([headers]).setFontWeight("bold");

    if (allFlatData.length > 0) {
      dataSheet.getRange(2, 1, allFlatData.length, headers.length).setValues(allFlatData);
      dataSheet.getRange(2, DATA_IDX.PLAN_DELIVERY + 1, allFlatData.length, 1).setNumberFormat("dd/mm/yyyy");
      dataSheet.getRange(2, DATA_IDX.INVOICE_NO + 1, allFlatData.length, 1).setNumberFormat("@");
      dataSheet.getRange(2, DATA_IDX.DELIVERY_NO + 1, allFlatData.length, 1).setNumberFormat("@");
    }

    applyMasterCoordinatesToDailyJob();

    // [REMOVED v5.4.002] populateAliasFromSCGRawData_() ถูกลบออกจาก Group 2 Pipeline
    // เหตุผล: M_ALIAS เป็น Single Writer — เขียนที่ autoEnrichAliasesFromFactBatch_() (Module 10) เท่านั้น
    // Group 2 (Daily Ops) ทำหน้าที่ "อ่าน" M_ALIAS เพื่อค้นหาพิกัด (fastLookupByShipToName)
    // ห้าม Group 2 "เขียน" M_ALIAS เด็ดขาด — เป็นการละเมิด Single Writer Pattern
    // หากต้องการดึงชื่อจาก SCG ดิบ → M_ALIAS ให้ใช้เมนู: ระบบ > ดึงชื่อจาก SCG ดิบ → M_ALIAS

    buildOwnerSummary();
    buildShipmentSummary();

    logInfo('ServiceSCG', `Successfully imported ${allFlatData.length} records`);
    ui.alert(`✅ ดึงข้อมูลสำเร็จ!\n- จำนวนรายการ: ${allFlatData.length} แถว\n- จับคู่พิกัด: เรียบร้อย`);

  } catch (e) {
    logError('ServiceSCG', `[SCG API] ${e.message}\n${e.stack || ''}`);
    ui.alert("❌ เกิดข้อผิดพลาด: " + e.message);
  } finally {
    lock.releaseLock();
  }
}

// ============================================================
// SECTION 2: fetchWithRetry_ — ดึงข้อมูลพร้อมกลไก Retry
// [FIX BUG-014] เพิ่ม content validation นอกเหนือจาก HTTP 200
// ============================================================

function fetchWithRetry_(url, options, maxRetries) {
  let lastErrMsg = '';
  for (let i = 0; i < maxRetries; i++) {
    try {
      const response = UrlFetchApp.fetch(url, options);
      const code = response.getResponseCode();
      const body = response.getContentText();

      if (code !== 200) {
        throw new Error('HTTP ' + code + ': ' + String(body).substring(0, 200));
      }
      // [FIX BUG-014] validate ก่อนคืนค่า เพื่อ short-circuit error message ที่กระจ่างขึ้น
      if (!body || body.length < 2) {
        throw new Error('SCG API ส่ง response ว่างเปล่า — Cookie อาจหมดอายุ');
      }
      const trimmed = body.trim();
      if (trimmed.charAt(0) !== '{' && trimmed.charAt(0) !== '[') {
        // ส่ง HTML/redirect กลับมา → คาดว่า Cookie หมดอายุ
        throw new Error(
          'SCG API ส่งกลับ non-JSON (ขึ้นต้นด้วย "' + trimmed.charAt(0) + '") — Cookie อาจหมดอายุหรือ endpoint redirect\n' +
          'Body (200 chars): ' + trimmed.substring(0, 200)
        );
      }
      return body;
    } catch (e) {
      lastErrMsg = e.message;
      if (i === maxRetries - 1) throw e;
      Utilities.sleep(1000 * Math.pow(2, i));
      logWarn('ServiceSCG', `[SCG API] Retry attempt ${i + 1}/${maxRetries} failed: ${e.message}. Retrying...`);
    }
  }
  throw new Error('fetchWithRetry_ exhausted ' + maxRetries + ' retries. Last error: ' + lastErrMsg);
}

// ============================================================
// SECTION 3: checkIsEPOD — ตรวจสอบ E-POD ตามเงื่อนไขเจ้าของงาน
// ============================================================

function checkIsEPOD(ownerName, invoiceNo) {
  if (!ownerName || !invoiceNo) return false;
  const owner = String(ownerName).toUpperCase();
  const inv = String(invoiceNo);

  const epodOwners = ["BETTERBE", "SCG EXPRESS", "เบทเตอร์แลนด์", "JWD TRANSPORT"];
  if (epodOwners.some(w => owner.includes(w.toUpperCase()))) return true;

  if (owner.includes("DENSO") || owner.includes("เด็นโซ่")) {
    if (inv.includes("_DOC")) return false;
    if (/^\d+(-.*)?$/.test(inv)) return true;
    return false;
  }

  return false;
}

// ============================================================
// SECTION 4: applyMasterCoordinatesToDailyJob
// ============================================================

/**
 * applyMasterCoordinatesToDailyJob
 * เรียก runLookupEnrichment จาก 17_SearchService.gs
 */
function applyMasterCoordinatesToDailyJob() {
  try {
    logInfo('ServiceSCG', 'applyMasterCoordinates → เรียก Module 17');
    runLookupEnrichment();
    logInfo('ServiceSCG', 'applyMasterCoordinates เสร็จสิ้น');
  } catch (err) {
    logError('ServiceSCG', err.message + '\n' + err.stack);
    safeUiAlert_('เกิดข้อผิดพลาด: ' + err.message);
  }
}

// ============================================================
// SECTION 5: buildOwnerSummary
// [FIX BUG-006] ใช้ SHEET.OWNER_SUMMARY แทน hardcoded Thai
// [FIX BUG-018] ใช้ getLastColumn() แทน hardcoded 6
// [FIX BUG-020] ใช้ Utilities.formatDate + Session.getScriptTimeZone
// [FIX NEW-013] ใช้ safeUiAlert_ trigger-safe
// ============================================================

function buildOwnerSummary() {
  try {
  const ss        = SpreadsheetApp.getActiveSpreadsheet();
  const dataSheet = ss.getSheetByName(SCG_CONFIG.SHEET_DATA);
  if (!dataSheet || dataSheet.getLastRow() < 2) return;

  const data     = dataSheet.getRange(2, 1, dataSheet.getLastRow() - 1, SCHEMA[SHEET.DAILY_JOB].length).getValues();
  const ownerMap = {};

  data.forEach(r => {
    const ownerName = r[DATA_IDX.SOLD_TO_NAME];
    const invoiceNo = r[DATA_IDX.INVOICE_NO];
    if (!ownerName) return;
    if (!ownerMap[ownerName]) ownerMap[ownerName] = { all: new Set(), epod: new Set() };
    if (!invoiceNo) return;
    if (checkIsEPOD(ownerName, invoiceNo)) {
      ownerMap[ownerName].epod.add(invoiceNo);
    } else {
      ownerMap[ownerName].all.add(invoiceNo);
    }
  });

  // [FIX BUG-006] ใช้ constant แทน hardcoded "สรุป_เจ้าของสินค้า"
  const summarySheet = ss.getSheetByName(SHEET.OWNER_SUMMARY);
  if (!summarySheet) {
    safeUiAlert_('❌ ไม่พบชีต ' + SHEET.OWNER_SUMMARY);
    logError('ServiceSCG', 'buildOwnerSummary: ไม่พบชีต ' + SHEET.OWNER_SUMMARY);
    return;
  }

  // [FIX BUG-018] ใช้ getLastColumn() แทน hardcoded 6
  // ป้องกันกรณีชีตมีคอลัมน์เพิ่ม → จะได้ clear ครบทุกคอลัมน์
  const OWNER_COLS = Math.max(6, summarySheet.getLastColumn());
  const summaryLastRow = summarySheet.getLastRow();
  if (summaryLastRow > 1) {
    summarySheet.getRange(2, 1, summaryLastRow - 1, OWNER_COLS)
                .clearContent()
                .setBackground(null);
  }

  // [FIX BUG-020] ใช้ formatted string ตาม script timezone
  const tz = Session.getScriptTimeZone();
  const nowStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss');

  const rows = [];
  Object.keys(ownerMap).sort().forEach(owner => {
    const o = ownerMap[owner];
    rows.push(["", owner, "", o.all.size, o.epod.size, nowStr]);
  });

  if (rows.length > 0) {
    summarySheet.getRange(2, 1, rows.length, 6).setValues(rows);
    summarySheet.getRange(2, 4, rows.length, 2).setNumberFormat("#,##0");
    summarySheet.getRange(2, 6, rows.length, 1).setNumberFormat("yyyy-mm-dd HH:mm:ss");
  }
  logInfo('ServiceSCG', `buildOwnerSummary: เขียน ${rows.length} แถว → ${SHEET.OWNER_SUMMARY}`);
  } catch (err) {
    logError('buildOwnerSummary', err.message + '\n' + err.stack);
  }
}

// ============================================================
// SECTION 6: buildShipmentSummary
// [FIX BUG-006/018/020/NEW-013] เช่นเดียวกับ buildOwnerSummary
// ============================================================

function buildShipmentSummary() {
  try {
  const ss        = SpreadsheetApp.getActiveSpreadsheet();
  const dataSheet = ss.getSheetByName(SCG_CONFIG.SHEET_DATA);
  if (!dataSheet || dataSheet.getLastRow() < 2) return;

  const data        = dataSheet.getRange(2, 1, dataSheet.getLastRow() - 1, SCHEMA[SHEET.DAILY_JOB].length).getValues();
  const shipmentMap = {};

  data.forEach(r => {
    const shipmentNo = r[DATA_IDX.SHIPMENT_NO];
    const truckLicense = r[DATA_IDX.TRUCK_LICENSE];
    const soldToName = r[DATA_IDX.SOLD_TO_NAME];
    const invoiceNo = r[DATA_IDX.INVOICE_NO];
    if (!shipmentNo || !truckLicense) return;
    const key = shipmentNo + "_" + truckLicense;
    if (!shipmentMap[key]) {
      shipmentMap[key] = { shipmentNo: shipmentNo, truck: truckLicense, all: new Set(), epod: new Set() };
    }
    if (!invoiceNo) return;
    if (checkIsEPOD(soldToName, invoiceNo)) {
      shipmentMap[key].epod.add(invoiceNo);
    } else {
      shipmentMap[key].all.add(invoiceNo);
    }
  });

  // [FIX BUG-006] ใช้ constant แทน hardcoded "สรุป_Shipment"
  const summarySheet = ss.getSheetByName(SHEET.SHIPMENT_SUM);
  if (!summarySheet) {
    safeUiAlert_('❌ ไม่พบชีต ' + SHEET.SHIPMENT_SUM);
    logError('ServiceSCG', 'buildShipmentSummary: ไม่พบชีต ' + SHEET.SHIPMENT_SUM);
    return;
  }

  // [FIX BUG-018] ใช้ getLastColumn() แทน hardcoded 7
  const SHIPMENT_COLS = Math.max(7, summarySheet.getLastColumn());
  const summaryLastRow = summarySheet.getLastRow();
  if (summaryLastRow > 1) {
    summarySheet.getRange(2, 1, summaryLastRow - 1, SHIPMENT_COLS)
                .clearContent()
                .setBackground(null);
  }

  // [FIX BUG-020] formatted timestamp
  const tz = Session.getScriptTimeZone();
  const nowStr = Utilities.formatDate(new Date(), tz, 'yyyy-MM-dd HH:mm:ss');

  const rows = [];
  Object.keys(shipmentMap).sort().forEach(key => {
    const s = shipmentMap[key];
    rows.push([key, s.shipmentNo, s.truck, "", s.all.size, s.epod.size, nowStr]);
  });

  if (rows.length > 0) {
    summarySheet.getRange(2, 1, rows.length, 7).setValues(rows);
    summarySheet.getRange(2, 5, rows.length, 2).setNumberFormat("#,##0");
    summarySheet.getRange(2, 7, rows.length, 1).setNumberFormat("yyyy-mm-dd HH:mm:ss");
  }
  logInfo('ServiceSCG', `buildShipmentSummary: เขียน ${rows.length} แถว → ${SHEET.SHIPMENT_SUM}`);
  } catch (err) {
    logError('buildShipmentSummary', err.message + '\n' + err.stack);
  }
}

// ============================================================
// SECTION 7: Clear Functions
// [FIX BUG-012] เพิ่ม confirmation dialog ใน clearAllSCGSheets_UI
// ============================================================

function clearAllSCGSheets_UI() {
  try {
  const ui = SpreadsheetApp.getUi();

  // [FIX BUG-012] confirmation dialog ก่อนลบข้อมูลถาวร
  // script-deleted rows bypass undo stack → กู้คืนไม่ได้
  const sheetsToClear = [SHEET.DAILY_JOB, SHEET.OWNER_SUMMARY, SHEET.SHIPMENT_SUM];
  const confirmMsg =
    '⚠️ ระบบจะลบข้อมูลทั้งหมดในชีตต่อไปนี้แบบถาวร (กู้คืนไม่ได้):\n' +
    sheetsToClear.map(n => '  • ' + n).join('\n') +
    '\n\nต้องการดำเนินการต่อหรือไม่?';
  const resp = ui.alert('🗑️ ยืนยันการล้างข้อมูล', confirmMsg, ui.ButtonSet.YES_NO);
  if (resp !== ui.Button.YES) {
    ui.alert('ℹ️ ยกเลิกการล้างข้อมูล');
    return;
  }

  const ss = SpreadsheetApp.getActiveSpreadsheet();
  ss.toast('🗑️ กำลังล้างข้อมูลชีตที่เลือก...', APP_NAME, -1);

  let cleared = 0;
  sheetsToClear.forEach(name => {
    const sheet = ss.getSheetByName(name);
    if (sheet && sheet.getLastRow() > 1) {
      sheet.deleteRows(2, sheet.getLastRow() - 1);
      cleared++;
    }
  });

  logInfo('ServiceSCG', `clearAllSCGSheets_UI: ล้าง ${cleared} ชีต`);
  ui.alert(`✅ ล้างข้อมูล ${cleared} ชีตเรียบร้อย`);
  } catch (err) {
    logError('clearAllSCGSheets_UI', err.message + '\n' + err.stack);
    SpreadsheetApp.getUi().alert('❌ clearAllSCGSheets_UI ล้มเหลว:\n' + err.message);
  }
}

function clearDailyJobLatLng() {
  try {
    const ss    = SpreadsheetApp.getActiveSpreadsheet();
    const sheet = ss.getSheetByName(SHEET.DAILY_JOB);
    if (!sheet || sheet.getLastRow() < 2) return;

    const totalRows    = sheet.getLastRow() - 1;
    const latActualCol = DATA_IDX.LATLNG_ACTUAL + 1;

    sheet.getRange(2, latActualCol, totalRows, 1).clearContent();
    sheet.getRange(2, 1, totalRows, SCHEMA[SHEET.DAILY_JOB].length)
         .setBackground(null);

    logInfo('ServiceSCG', `clearDailyJobLatLng: ล้าง ${totalRows} แถว`);
  } catch (err) {
    logError('clearDailyJobLatLng', err.message + '\n' + err.stack);
    SpreadsheetApp.getUi().alert('❌ clearDailyJobLatLng ล้มเหลว:\n' + err.message);
  }
}
