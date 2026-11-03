const WASHLY_PROPERTIES = PropertiesService.getScriptProperties();
const WASHLY_STATUSES = ["Diterima", "Dicuci", "Dikeringkan", "Siap diambil", "Selesai", "Dibatalkan"];
const WASHLY_SESSION_SECONDS = 21600;
const WASHLY_TIME_ZONE = "Asia/Jakarta";

function doGet() {
  const template = HtmlService.createTemplateFromFile("Index");
  template.publicUrl = ScriptApp.getService().getUrl() || "";
  return template.evaluate()
    .setTitle("Washly — Sistem Manajemen Laundry")
    .addMetaTag("viewport", "width=device-width, initial-scale=1");
}

function include_(filename) {
  return HtmlService.createHtmlOutputFromFile(filename).getContent();
}

function washlyGetStatus() {
  const spreadsheetId = WASHLY_PROPERTIES.getProperty("SPREADSHEET_ID");
  const setupKey = WASHLY_PROPERTIES.getProperty("SETUP_KEY");
  return {
    configured: Boolean(spreadsheetId),
    setupAvailable: !spreadsheetId && Boolean(setupKey)
  };
}

function washlySetup(setupKey, input) {
  if (WASHLY_PROPERTIES.getProperty("SPREADSHEET_ID")) {
    throw new Error("Aplikasi sudah disiapkan. Silakan masuk menggunakan akun admin.");
  }
  const expectedKey = WASHLY_PROPERTIES.getProperty("SETUP_KEY");
  if (!expectedKey || expectedKey.length < 32 || !constantTimeEquals_(String(setupKey || ""), expectedKey)) {
    throw new Error("Kunci setup tidak benar atau belum diatur di Project Settings.");
  }

  const username = requiredText_(input.username, 32, "Username");
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) {
    throw new Error("Username harus 3–32 karakter: huruf, angka, titik, garis bawah, atau tanda hubung.");
  }
  const name = requiredText_(input.name, 60, "Nama administrator");
  const password = validatePassword_(input.password);
  const phone = optionalText_(input.phone, 24, "Nomor kontak");

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (WASHLY_PROPERTIES.getProperty("SPREADSHEET_ID")) {
      throw new Error("Aplikasi sudah disiapkan. Silakan masuk menggunakan akun admin.");
    }

    const spreadsheet = SpreadsheetApp.create("Washly Laundry Data");
    const ordersSheet = spreadsheet.getSheets()[0];
    ordersSheet.setName("Orders");
    ordersSheet.getRange(1, 1, 1, 10).setValues([[
      "id", "name", "phone", "service", "weight", "pricePerKg", "amount", "status", "receivedAt", "createdAt"
    ]]);
    ordersSheet.setFrozenRows(1);

    const servicesSheet = spreadsheet.insertSheet("Services");
    servicesSheet.getRange(1, 1, 1, 3).setValues([["name", "price", "turnaround"]]);
    servicesSheet.getRange(2, 1, 3, 3).setValues([
      ["Cuci Komplit", 7000, "2–3 hari"],
      ["Cuci & Setrika", 10000, "2–3 hari"],
      ["Setrika", 5000, "1–2 hari"]
    ]);
    servicesSheet.setFrozenRows(1);

    const historySheet = spreadsheet.insertSheet("StatusHistory");
    historySheet.getRange(1, 1, 1, 4).setValues([["orderId", "status", "changedAt", "changedBy"]]);
    historySheet.setFrozenRows(1);

    const adminSheet = spreadsheet.insertSheet("Admin");
    adminSheet.getRange(1, 1, 1, 5).setValues([["username", "name", "phone", "salt", "passwordHash"]]);
    const salt = Utilities.getUuid();
    adminSheet.getRange(2, 1, 1, 5).setValues([[
      safeSheetText_(username), safeSheetText_(name), safeSheetText_(phone), salt, safeSheetText_(passwordHash_(password, salt))
    ]]);
    adminSheet.setFrozenRows(1);

    WASHLY_PROPERTIES.setProperty("SPREADSHEET_ID", spreadsheet.getId());
    WASHLY_PROPERTIES.deleteProperty("SETUP_KEY");
    return washlyLogin(username, password);
  } finally {
    lock.releaseLock();
  }
}

function washlyLogin(usernameInput, passwordInput) {
  const username = String(usernameInput || "").trim();
  const password = String(passwordInput || "");
  const attemptsCache = CacheService.getScriptCache();
  const attemptsKey = "login_attempts_" + digestText_(username.toLowerCase());
  const attempts = Number(attemptsCache.get(attemptsKey) || 0);
  if (attempts >= 5) {
    throw new Error("Terlalu banyak percobaan login. Coba kembali beberapa menit lagi.");
  }

  const admin = readAdmin_();
  const isValid = admin &&
    admin.username.toLowerCase() === username.toLowerCase() &&
    constantTimeEquals_(passwordHash_(password, admin.salt), admin.passwordHash);
  if (!isValid) {
    attemptsCache.put(attemptsKey, String(attempts + 1), 300);
    throw new Error("Username atau kata sandi salah.");
  }

  attemptsCache.remove(attemptsKey);
  const token = Utilities.getUuid() + Utilities.getUuid();
  CacheService.getScriptCache().put(sessionCacheKey_(token), "admin", WASHLY_SESSION_SECONDS);
  return { token: token, profile: publicProfile_(admin) };
}

function washlyApi(action, input, token) {
  const cache = CacheService.getScriptCache();
  const key = sessionCacheKey_(String(token || ""));
  if (!token || cache.get(key) !== "admin") {
    return { authRequired: true, error: "Sesi login berakhir. Silakan masuk kembali." };
  }
  cache.put(key, "admin", WASHLY_SESSION_SECONDS);

  const payload = input && typeof input === "object" ? input : {};
  if (action === "logout") {
    cache.remove(key);
    return { success: true };
  }
  if (action === "bootstrap") {
    const readLock = LockService.getScriptLock();
    readLock.waitLock(10000);
    try {
      return bootstrapData_();
    } finally {
      readLock.releaseLock();
    }
  }

  const lock = LockService.getScriptLock();
  lock.waitLock(10000);
  try {
    if (action === "save_order") return saveOrder_(payload.order || {});
    if (action === "change_status") return changeStatus_(payload);
    if (action === "delete_order") return deleteOrder_(payload);
    if (action === "save_service") return saveService_(payload);
    if (action === "delete_service") return deleteService_(payload);
    if (action === "save_account") return saveAccount_(payload);
    throw new Error("Perintah tidak dikenal.");
  } finally {
    lock.releaseLock();
  }
}

function bootstrapData_() {
  const spreadsheet = openSpreadsheet_();
  const admin = readAdmin_();
  const orderRows = readDataRows_(spreadsheet.getSheetByName("Orders"));
  const historyRows = readDataRows_(spreadsheet.getSheetByName("StatusHistory"));
  const historyByOrder = {};
  historyRows.forEach(function (row) {
    const id = String(row[0]);
    if (!historyByOrder[id]) historyByOrder[id] = [];
    historyByOrder[id].push({ status: String(row[1]), changedAt: asIsoString_(row[2]) });
  });

  const orders = orderRows.map(function (row) {
    const name = String(row[1]);
    return {
      id: String(row[0]),
      name: name,
      phone: String(row[2]),
      service: String(row[3]),
      weight: Number(row[4]),
      pricePerKg: Number(row[5]),
      amount: Number(row[6]),
      status: String(row[7]),
      receivedAt: asIsoString_(row[8]),
      createdAt: asIsoString_(row[9]),
      initials: name.split(/\s+/).slice(0, 2).map(function (part) { return part[0] || ""; }).join("").toUpperCase(),
      avatar: "av-purple",
      statusHistory: historyByOrder[String(row[0])] || []
    };
  }).sort(function (left, right) {
    return Date.parse(right.receivedAt) - Date.parse(left.receivedAt);
  });

  const services = readDataRows_(spreadsheet.getSheetByName("Services")).map(function (row) {
    return { name: String(row[0]), price: Number(row[1]), turnaround: String(row[2]) };
  });

  return { profile: publicProfile_(admin), orders: orders, services: services };
}

function saveOrder_(input) {
  const name = requiredText_(input.name, 80, "Nama pelanggan");
  const phone = requiredText_(input.phone, 24, "Nomor telepon");
  const serviceName = requiredText_(input.service, 60, "Layanan");
  const weight = Number(input.weight);
  const pricePerKg = Number(input.pricePerKg);
  if (!Number.isFinite(weight) || weight <= 0 || weight > 10000) {
    throw new Error("Berat cucian harus lebih dari 0 kg dan maksimal 10.000 kg.");
  }
  if (!Number.isFinite(pricePerKg) || pricePerKg <= 0 || pricePerKg > 100000000) {
    throw new Error("Harga layanan per kg tidak valid.");
  }
  if (WASHLY_STATUSES.indexOf(input.status) === -1) throw new Error("Status cucian tidak valid.");
  const receivedAt = validDate_(input.receivedAt, "Tanggal masuk");

  const spreadsheet = openSpreadsheet_();
  const ordersSheet = spreadsheet.getSheetByName("Orders");
  const rows = readDataRows_(ordersSheet);
  const orderId = String(input.id || "").trim();
  const rowIndex = orderId ? rows.findIndex(function (row) { return String(row[0]) === orderId; }) : -1;
  if (orderId && rowIndex === -1) throw new Error("Data cucian tidak ditemukan.");

  const services = readDataRows_(spreadsheet.getSheetByName("Services"));
  if (!services.some(function (row) { return String(row[0]) === serviceName; })) {
    throw new Error("Pilih layanan yang tersedia di daftar harga.");
  }

  const now = new Date().toISOString();
  const id = orderId || createOrderId_(rows);
  const previous = rowIndex === -1 ? null : rows[rowIndex];
  const values = [
    safeSheetText_(id), safeSheetText_(name), safeSheetText_(phone), safeSheetText_(serviceName),
    weight, pricePerKg, Math.round(weight * pricePerKg), input.status, receivedAt,
    previous ? previous[9] : now
  ];

  if (rowIndex === -1) {
    ordersSheet.appendRow(values);
    appendHistory_(spreadsheet, id, input.status);
  } else {
    ordersSheet.getRange(rowIndex + 2, 1, 1, values.length).setValues([values]);
    if (String(previous[7]) !== input.status) appendHistory_(spreadsheet, id, input.status);
  }
  SpreadsheetApp.flush();
  return { success: true, id: id };
}

function changeStatus_(input) {
  const orderId = requiredText_(input.id, 32, "Kode cucian");
  if (WASHLY_STATUSES.indexOf(input.status) === -1) throw new Error("Status cucian tidak valid.");
  const spreadsheet = openSpreadsheet_();
  const sheet = spreadsheet.getSheetByName("Orders");
  const rows = readDataRows_(sheet);
  const index = rows.findIndex(function (row) { return String(row[0]) === orderId; });
  if (index === -1) throw new Error("Data cucian tidak ditemukan.");
  if (String(rows[index][7]) !== input.status) {
    sheet.getRange(index + 2, 8).setValue(input.status);
    appendHistory_(spreadsheet, orderId, input.status);
    SpreadsheetApp.flush();
  }
  return { success: true };
}

function deleteOrder_(input) {
  const orderId = requiredText_(input.id, 32, "Kode cucian");
  const spreadsheet = openSpreadsheet_();
  const orderSheet = spreadsheet.getSheetByName("Orders");
  const orderRows = readDataRows_(orderSheet);
  const index = orderRows.findIndex(function (row) { return String(row[0]) === orderId; });
  if (index === -1) throw new Error("Data cucian tidak ditemukan.");
  orderSheet.deleteRow(index + 2);

  const historySheet = spreadsheet.getSheetByName("StatusHistory");
  const historyRows = readDataRows_(historySheet);
  for (let row = historyRows.length - 1; row >= 0; row--) {
    if (String(historyRows[row][0]) === orderId) historySheet.deleteRow(row + 2);
  }
  SpreadsheetApp.flush();
  return { success: true };
}

function saveService_(input) {
  const name = requiredText_(input.name, 60, "Nama layanan");
  const turnaround = requiredText_(input.turnaround, 40, "Estimasi layanan");
  const price = Number(input.price);
  if (!Number.isFinite(price) || price <= 0 || price > 100000000) throw new Error("Harga layanan tidak valid.");

  const sheet = openSpreadsheet_().getSheetByName("Services");
  const rows = readDataRows_(sheet);
  const originalName = String(input.originalName || "").trim();
  const index = originalName ? rows.findIndex(function (row) { return String(row[0]) === originalName; }) : -1;
  if (originalName && index === -1) throw new Error("Layanan yang akan diubah tidak ditemukan.");
  const duplicate = rows.some(function (row, rowIndex) {
    return rowIndex !== index && String(row[0]).toLowerCase() === name.toLowerCase();
  });
  if (duplicate) throw new Error("Nama layanan tersebut sudah ada.");
  const values = [safeSheetText_(name), price, safeSheetText_(turnaround)];
  if (index === -1) sheet.appendRow(values);
  else sheet.getRange(index + 2, 1, 1, 3).setValues([values]);
  SpreadsheetApp.flush();
  return { success: true };
}

function deleteService_(input) {
  const name = requiredText_(input.name, 60, "Nama layanan");
  const spreadsheet = openSpreadsheet_();
  const serviceSheet = spreadsheet.getSheetByName("Services");
  const services = readDataRows_(serviceSheet);
  const index = services.findIndex(function (row) { return String(row[0]) === name; });
  if (index === -1) throw new Error("Layanan tidak ditemukan.");
  if (services.length <= 1) throw new Error("Minimal harus tersedia satu layanan.");
  const used = readDataRows_(spreadsheet.getSheetByName("Orders")).some(function (row) {
    return String(row[3]) === name;
  });
  if (used) throw new Error("Layanan ini masih tercatat pada riwayat cucian dan tidak dapat dihapus.");
  serviceSheet.deleteRow(index + 2);
  SpreadsheetApp.flush();
  return { success: true };
}

function saveAccount_(input) {
  const username = requiredText_(input.username, 32, "Username");
  if (!/^[A-Za-z0-9._-]{3,32}$/.test(username)) {
    throw new Error("Username harus 3–32 karakter: huruf, angka, titik, garis bawah, atau tanda hubung.");
  }
  const name = requiredText_(input.name, 60, "Nama administrator");
  const phone = optionalText_(input.phone, 24, "Nomor kontak");
  const currentPassword = String(input.currentPassword || "");
  const newPassword = String(input.newPassword || "");
  if (!currentPassword) throw new Error("Kata sandi saat ini wajib diisi.");
  if (newPassword && (newPassword.length < 12 || newPassword.length > 72)) {
    throw new Error("Kata sandi baru harus 12–72 karakter.");
  }

  const admin = readAdmin_();
  if (!constantTimeEquals_(passwordHash_(currentPassword, admin.salt), admin.passwordHash)) {
    throw new Error("Kata sandi saat ini salah.");
  }
  const sheet = openSpreadsheet_().getSheetByName("Admin");
  const salt = newPassword ? Utilities.getUuid() : admin.salt;
  const passwordHash = newPassword ? passwordHash_(newPassword, salt) : admin.passwordHash;
  sheet.getRange(2, 1, 1, 5).setValues([[
    safeSheetText_(username), safeSheetText_(name), safeSheetText_(phone), salt, safeSheetText_(passwordHash)
  ]]);
  SpreadsheetApp.flush();
  return { success: true, profile: { username: username, name: name, phone: phone } };
}

function readAdmin_() {
  const spreadsheetId = WASHLY_PROPERTIES.getProperty("SPREADSHEET_ID");
  if (!spreadsheetId) throw new Error("Database belum disiapkan.");
  const sheet = SpreadsheetApp.openById(spreadsheetId).getSheetByName("Admin");
  const values = sheet && sheet.getLastRow() > 1 ? sheet.getRange(2, 1, 1, 5).getValues()[0] : null;
  if (!values) throw new Error("Data administrator tidak ditemukan.");
  return {
    username: String(values[0]),
    name: String(values[1]),
    phone: String(values[2]),
    salt: String(values[3]),
    passwordHash: String(values[4])
  };
}

function publicProfile_(admin) {
  return { username: admin.username, name: admin.name, phone: admin.phone };
}

function openSpreadsheet_() {
  const spreadsheetId = WASHLY_PROPERTIES.getProperty("SPREADSHEET_ID");
  if (!spreadsheetId) throw new Error("Spreadsheet belum disiapkan.");
  return SpreadsheetApp.openById(spreadsheetId);
}

function readDataRows_(sheet) {
  if (!sheet) throw new Error("Struktur spreadsheet tidak lengkap. Periksa tab data aplikasi.");
  const lastRow = sheet.getLastRow();
  return lastRow < 2 ? [] : sheet.getRange(2, 1, lastRow - 1, sheet.getLastColumn()).getValues();
}

function createOrderId_(rows) {
  const date = Utilities.formatDate(new Date(), WASHLY_TIME_ZONE, "yyMMdd");
  let id;
  do {
    id = "WL" + date + Math.floor(100000 + Math.random() * 900000);
  } while (rows.some(function (row) { return String(row[0]) === id; }));
  return id;
}

function appendHistory_(spreadsheet, orderId, status) {
  const admin = readAdmin_();
  spreadsheet.getSheetByName("StatusHistory").appendRow([
    safeSheetText_(orderId), status, new Date().toISOString(), safeSheetText_(admin.username)
  ]);
}

function requiredText_(value, maximum, label) {
  if (typeof value !== "string") throw new Error(label + " harus berupa teks.");
  const result = value.trim();
  if (!result || result.length > maximum) throw new Error(label + " wajib diisi (maksimal " + maximum + " karakter).");
  return result;
}

function optionalText_(value, maximum, label) {
  if (typeof value !== "string") throw new Error(label + " harus berupa teks.");
  const result = value.trim();
  if (result.length > maximum) throw new Error(label + " maksimal " + maximum + " karakter.");
  return result;
}

function validatePassword_(value) {
  if (typeof value !== "string" || value.length < 12 || value.length > 72) {
    throw new Error("Kata sandi harus 12–72 karakter.");
  }
  return value;
}

function validDate_(value, label) {
  const date = new Date(value);
  if (typeof value !== "string" || !Number.isFinite(date.getTime())) throw new Error(label + " tidak valid.");
  return date.toISOString();
}

function asIsoString_(value) {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isFinite(date.getTime()) ? date.toISOString() : "";
}

function safeSheetText_(value) {
  const text = String(value);
  return /^\s*[=+\-@]/.test(text) ? "'" + text : text;
}

function passwordHash_(password, salt) {
  return hexDigest_(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    salt + "\u0000" + password,
    Utilities.Charset.UTF_8
  ));
}

function digestText_(value) {
  return hexDigest_(Utilities.computeDigest(
    Utilities.DigestAlgorithm.SHA_256,
    value,
    Utilities.Charset.UTF_8
  ));
}

function hexDigest_(digest) {
  return digest.map(function (byte) {
    return (byte & 255).toString(16).padStart(2, "0");
  }).join("");
}

function constantTimeEquals_(left, right) {
  if (left.length !== right.length) return false;
  let difference = 0;
  for (let index = 0; index < left.length; index++) {
    difference |= left.charCodeAt(index) ^ right.charCodeAt(index);
  }
  return difference === 0;
}

function sessionCacheKey_(token) {
  return "session_" + digestText_(token);
}
