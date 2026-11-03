const statuses = ["Diterima", "Dicuci", "Dikeringkan", "Siap diambil", "Selesai", "Dibatalkan"];
const pageInfo = {
  dashboard: ["Dashboard", "Pantau pemasukan dan status cucian Anda."],
  pesanan: ["Data Pesanan", "Kelola cucian yang sedang diproses."],
  riwayat: ["Riwayat Cucian", "Cari dan ekspor riwayat cucian berdasarkan tanggal masuk."],
  pelanggan: ["Data Pelanggan", "Daftar pelanggan yang tercatat dari riwayat cucian."],
  layanan: ["Layanan", "Pilihan layanan dan harga laundry."],
  stok: ["Stok & Inventori", "Ringkasan persediaan kebutuhan operasional laundry."],
  laporan: ["Laporan", "Ringkasan pemasukan berdasarkan data cucian."],
  pengaturan: ["Pengaturan", "Kelola informasi cabang dan preferensi akun."]
};
const staticPages = {
  stok: {
    columns: ["NAMA BARANG", "KATEGORI", "STOK SAAT INI", "BATAS MINIMUM", "STATUS"],
    rows: [
      ["Deterjen cair", "Bahan cuci", "18 liter", "10 liter", "Contoh"],
      ["Pewangi pakaian", "Bahan cuci", "7 liter", "8 liter", "Contoh"],
      ["Plastik kemasan", "Kemasan", "240 pcs", "100 pcs", "Contoh"],
      ["Pelembut pakaian", "Bahan cuci", "12 liter", "8 liter", "Contoh"]
    ]
  },
  pengaturan: {
    columns: ["PENGATURAN", "DETAIL"],
    rows: [["Akun", "Administrator"], ["Autentikasi", "Login menggunakan kata sandi"], ["Penyimpanan", "Database MySQL server"], ["Pembaruan", "Perubahan data langsung tersimpan di server"]]
  }
};
const escapeHtml = (value) => String(value).replace(/[&<>"']/g, (character) => ({
  "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;"
})[character]);
const statusClass = (status) => `status-${status.toLowerCase().replaceAll(" ", "-")}`;
const money = (amount) => `Rp ${Number(amount).toLocaleString("id-ID")}`;
const localDateTimeValue = (date) => {
  const localDate = new Date(date);
  return new Date(localDate.getTime() - localDate.getTimezoneOffset() * 60000).toISOString().slice(0, 16);
};
const localDateKey = (date) => {
  const localDate = new Date(date);
  return `${localDate.getFullYear()}-${String(localDate.getMonth() + 1).padStart(2, "0")}-${String(localDate.getDate()).padStart(2, "0")}`;
};
const monthNames = { jan: 0, feb: 1, mar: 2, apr: 3, mei: 4, jun: 5, jul: 6, agu: 7, sep: 8, okt: 9, nov: 10, des: 11 };

function parseLegacyDate(value) {
  const match = String(value || "").match(/(\d{1,2})\s+([a-z]+)\s+(\d{4}),?\s*(\d{1,2}):(\d{2})/i);
  if (!match || monthNames[match[2].toLowerCase()] === undefined) return new Date().toISOString();
  const [, day, month, year, hour, minute] = match;
  return new Date(Number(year), monthNames[month.toLowerCase()], Number(day), Number(hour), Number(minute)).toISOString();
}

function normalizeOrder(order) {
  if (!order || typeof order.id !== "string" || typeof order.name !== "string") return null;
  const receivedAt = typeof order.receivedAt === "string" && !Number.isNaN(Date.parse(order.receivedAt))
    ? order.receivedAt
    : parseLegacyDate(order.date);
  const status = statuses.includes(order.status) ? order.status : "Diterima";
  const savedHistory = Array.isArray(order.statusHistory)
    ? order.statusHistory.filter((entry) => entry && statuses.includes(entry.status) && !Number.isNaN(Date.parse(entry.changedAt)))
    : [];
  const statusHistory = savedHistory.length ? savedHistory : [{ status, changedAt: order.createdAt || receivedAt }];
  return {
    id: order.id,
    name: order.name,
    phone: typeof order.phone === "string" ? order.phone : "",
    service: typeof order.service === "string" ? order.service : "Cuci Komplit",
    weight: Number.isFinite(Number(order.weight)) && Number(order.weight) > 0 ? Number(order.weight) : 1,
    pricePerKg: Number.isFinite(Number(order.pricePerKg)) && Number(order.pricePerKg) > 0
      ? Number(order.pricePerKg)
      : Math.round(Number(order.amount || 7000) / (Number(order.weight) || 1)),
    amount: Number.isFinite(Number(order.amount)) ? Number(order.amount) : 0,
    status,
    receivedAt,
    createdAt: order.createdAt || receivedAt,
    initials: typeof order.initials === "string" ? order.initials : order.name.split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase(),
    avatar: typeof order.avatar === "string" ? order.avatar : "av-purple",
    statusHistory
  };
}

let orders = [];
let services = [];
let profile = { name: "", username: "", phone: "" };
let csrfToken = "";
let activeFilter = "Semua status";
let activePage = "dashboard";
let toastTimer;
const tableBody = document.querySelector("#ordersTableBody");
const tableHead = document.querySelector("#ordersTableHead");
const searchInput = document.querySelector("#orderSearch");
const dateFrom = document.querySelector("#dateFrom");
const dateTo = document.querySelector("#dateTo");
const emptyState = document.querySelector("#emptyState");
const modal = document.querySelector("#orderModal");
const accountModal = document.querySelector("#accountModal");
const serviceModal = document.querySelector("#serviceModal");
const toast = document.querySelector("#toast");
const orderForm = document.querySelector("#orderForm");

function showToast(message) {
  toast.textContent = message;
  toast.classList.add("visible");
  window.clearTimeout(toastTimer);
  toastTimer = window.setTimeout(() => toast.classList.remove("visible"), 3500);
}

async function apiRequest(action, payload = null) {
  const headers = { Accept: "application/json" };
  const options = { method: payload === null ? "GET" : "POST", headers, credentials: "same-origin", cache: "no-store" };
  if (payload !== null) {
    headers["Content-Type"] = "application/json";
    headers["X-CSRF-Token"] = csrfToken;
    options.body = JSON.stringify({ action, ...payload });
  } else {
    action = `${action}${action.includes("?") ? "&" : "?"}action=bootstrap`;
  }
  const response = await fetch(payload === null ? action : "api.php", options);
  let result;
  try {
    result = await response.json();
  } catch (error) {
    throw new Error("Server mengirim respons yang tidak terbaca. Periksa konfigurasi PHP dan MySQL.");
  }
  if (response.status === 401) {
    window.location.assign("login.php");
    throw new Error(result.error || "Sesi login telah berakhir.");
  }
  if (!response.ok) throw new Error(result.error || `Permintaan gagal (${response.status}).`);
  return result;
}

async function refreshData(showErrors = false) {
  try {
    const data = await apiRequest("api.php");
    csrfToken = data.csrfToken;
    orders = data.orders.map(normalizeOrder).filter(Boolean);
    services = data.services;
    profile = data.profile;
    document.querySelector("#logoutCsrf").value = csrfToken;
    updateServiceOptions();
    updateProfileUI();
    document.querySelector("#greeting").textContent = `${greeting}, ${profile.name.split(/\s+/)[0]} ✨`;
    renderCurrentPage();
    return true;
  } catch (error) {
    console.error("Data Washly tidak dapat diperbarui.", error);
    if (showErrors) showToast(error.message);
    return false;
  }
}

function updateServiceOptions(selectedName) {
  const serviceSelect = orderForm.elements.service;
  const options = services.map((service) =>
    `<option value="${escapeHtml(service.name)}">${escapeHtml(service.name)} — ${money(service.price)}/kg</option>`
  );
  if (selectedName && !services.some((service) => service.name === selectedName)) {
    options.push(`<option value="${escapeHtml(selectedName)}">${escapeHtml(selectedName)} — layanan lama</option>`);
  }
  serviceSelect.innerHTML = options.join("");
  if (services.some((service) => service.name === selectedName)) serviceSelect.value = selectedName;
  else if (services.length) serviceSelect.value = services[0].name;
}

function orderMatchesFilters(order) {
  const query = searchInput.value.trim().toLocaleLowerCase("id");
  const matchesQuery = [order.id, order.name, order.phone, order.service, order.status]
    .some((value) => String(value).toLocaleLowerCase("id").includes(query));
  const matchesStatus = activeFilter === "Semua status" || order.status === activeFilter;
  const receivedDate = localDateKey(order.receivedAt);
  const matchesFrom = !dateFrom.value || receivedDate >= dateFrom.value;
  const matchesTo = !dateTo.value || receivedDate <= dateTo.value;
  return matchesQuery && matchesStatus && (activePage !== "riwayat" || (matchesFrom && matchesTo));
}

function sortedOrders() {
  return orders.filter(orderMatchesFilters).sort((first, second) => second.receivedAt.localeCompare(first.receivedAt));
}

function renderOrders() {
  tableHead.innerHTML = "<tr><th>ID PESANAN</th><th>PELANGGAN</th><th>BERAT</th><th>LAYANAN</th><th>TANGGAL MASUK</th><th>TOTAL</th><th>STATUS</th><th>UBAH STATUS</th><th>AKSI</th></tr>";
  const filtered = sortedOrders();
  const visible = activePage === "dashboard" ? filtered.slice(0, 5) : filtered;
  tableBody.innerHTML = visible.map((order) => {
    const receivedAt = new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "short", year: "numeric", hour: "2-digit", minute: "2-digit" }).format(new Date(order.receivedAt));
    const latestHistory = order.statusHistory[order.statusHistory.length - 1];
    const statusHistory = activePage === "riwayat"
      ? `<small class="status-history">Terakhir diubah: ${escapeHtml(new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(latestHistory.changedAt)))}</small>`
      : "";
    return `
      <tr>
        <td><span class="order-id">${escapeHtml(order.id)}</span></td>
        <td><div class="customer-cell"><span class="customer-avatar ${escapeHtml(order.avatar)}">${escapeHtml(order.initials)}</span><span><strong>${escapeHtml(order.name)}</strong><small>${escapeHtml(order.phone)}</small></span></div></td>
        <td>${Number(order.weight).toLocaleString("id-ID")} kg</td>
        <td>${escapeHtml(order.service)}</td>
        <td>${escapeHtml(receivedAt)}</td>
        <td><strong>${money(order.amount)}</strong></td>
        <td><span class="status-pill ${statusClass(order.status)}">${escapeHtml(order.status)}</span>${statusHistory}</td>
        <td><select class="row-status-select" data-order-id="${escapeHtml(order.id)}" aria-label="Ubah status ${escapeHtml(order.id)}">${statuses.map((status) => `<option${status === order.status ? " selected" : ""}>${status}</option>`).join("")}</select></td>
        <td><div class="row-actions"><button class="row-action" data-edit-order="${escapeHtml(order.id)}">Edit</button><button class="row-action row-delete" data-delete-order="${escapeHtml(order.id)}">Hapus</button></div></td>
      </tr>`;
  }).join("");
  emptyState.textContent = activePage === "riwayat" ? "Belum ada riwayat pada tanggal atau pencarian ini." : "Belum ada cucian. Pilih “Buat Pesanan” untuk mencatat pakaian masuk.";
  emptyState.classList.toggle("hidden", visible.length > 0);
  document.querySelector("#tableSummary").textContent = activePage === "dashboard"
    ? `Menampilkan ${visible.length} cucian terbaru dari ${filtered.length} catatan`
    : `Menampilkan ${visible.length} dari ${filtered.length} catatan`;
  document.querySelector("#orderCount").textContent = String(orders.filter((order) => !["Selesai", "Dibatalkan"].includes(order.status)).length);
}

function renderCustomers() {
  const customers = new Map();
  orders.forEach((order) => {
    const key = order.phone || order.name.trim().toLocaleLowerCase("id");
    const customer = customers.get(key) || { name: order.name, phone: order.phone, count: 0, amount: 0, latest: order.receivedAt };
    customer.count += 1;
    if (order.status !== "Dibatalkan") customer.amount += order.amount;
    if (order.receivedAt > customer.latest) customer.latest = order.receivedAt;
    customers.set(key, customer);
  });
  const query = searchInput.value.trim().toLocaleLowerCase("id");
  const list = [...customers.values()].filter((customer) => `${customer.name} ${customer.phone}`.toLocaleLowerCase("id").includes(query));
  tableHead.innerHTML = "<tr><th>NAMA PELANGGAN</th><th>NOMOR TELEPON</th><th>TOTAL PESANAN</th><th>TOTAL CUCIAN</th><th>TERAKHIR MASUK</th></tr>";
  tableBody.innerHTML = list.map((customer) => `<tr><td>${escapeHtml(customer.name)}</td><td>${escapeHtml(customer.phone || "—")}</td><td>${customer.count} pesanan</td><td>${money(customer.amount)}</td><td>${escapeHtml(new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "short", year: "numeric" }).format(new Date(customer.latest)))}</td></tr>`).join("");
  emptyState.textContent = "Daftar pelanggan muncul otomatis setelah pesanan cucian dicatat.";
  emptyState.classList.toggle("hidden", list.length > 0);
  document.querySelector("#tableSummary").textContent = `Menampilkan ${list.length} dari ${customers.size} pelanggan`;
}

function renderReports() {
  const reports = new Map();
  orders.forEach((order) => {
    const key = localDateKey(order.receivedAt);
    const report = reports.get(key) || { count: 0, revenueCount: 0, revenue: 0, weight: 0 };
    report.count += 1;
    if (order.status !== "Dibatalkan") {
      report.revenueCount += 1;
      report.revenue += order.amount;
      report.weight += order.weight;
    }
    reports.set(key, report);
  });
  const query = searchInput.value.trim().toLocaleLowerCase("id");
  const rows = [...reports.entries()].sort(([first], [second]) => second.localeCompare(first))
    .filter(([date]) => new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "long", year: "numeric" }).format(new Date(`${date}T12:00:00`)).toLocaleLowerCase("id").includes(query));
  tableHead.innerHTML = "<tr><th>TANGGAL MASUK</th><th>JUMLAH PESANAN</th><th>BERAT CUCIAN</th><th>TOTAL PEMASUKAN</th><th>RATA-RATA TRANSAKSI</th></tr>";
  tableBody.innerHTML = rows.map(([date, report]) => `<tr><td>${escapeHtml(new Intl.DateTimeFormat("id-ID", { day: "2-digit", month: "long", year: "numeric" }).format(new Date(`${date}T12:00:00`)))}</td><td>${report.count} pesanan</td><td>${report.weight.toLocaleString("id-ID")} kg</td><td>${money(report.revenue)}</td><td>${money(report.revenueCount ? Math.round(report.revenue / report.revenueCount) : 0)}</td></tr>`).join("");
  emptyState.textContent = "Laporan akan terisi otomatis setelah cucian masuk dicatat.";
  emptyState.classList.toggle("hidden", rows.length > 0);
  document.querySelector("#tableSummary").textContent = `Menampilkan ${rows.length} hari dengan transaksi`;
}

function renderServices() {
  const query = searchInput.value.trim().toLocaleLowerCase("id");
  const rows = services.filter((service) => `${service.name} ${service.turnaround}`.toLocaleLowerCase("id").includes(query));
  tableHead.innerHTML = "<tr><th>NAMA LAYANAN</th><th>HARGA PER KG</th><th>ESTIMASI SELESAI</th><th>JUMLAH PESANAN</th><th>AKSI</th></tr>";
  tableBody.innerHTML = rows.map((service) => {
    const count = orders.filter((order) => order.service === service.name).length;
    return `<tr><td><strong>${escapeHtml(service.name)}</strong></td><td>${money(service.price)} / kg</td><td>${escapeHtml(service.turnaround)}</td><td>${count} pesanan</td><td><div class="row-actions"><button class="row-action" data-edit-service="${escapeHtml(service.name)}">Ubah</button><button class="row-action row-delete" data-delete-service="${escapeHtml(service.name)}">Hapus</button></div></td></tr>`;
  }).join("");
  emptyState.textContent = "Belum ada layanan. Tambahkan layanan dan harga terlebih dahulu.";
  emptyState.classList.toggle("hidden", rows.length > 0);
  document.querySelector("#tableSummary").textContent = `Menampilkan ${rows.length} dari ${services.length} layanan`;
}

function renderStaticPage(page) {
  const data = staticPages[page] || { columns: ["DATA"], rows: [] };
  const query = searchInput.value.trim().toLocaleLowerCase("id");
  const rows = data.rows.filter((row) => row.some((value) => value.toLocaleLowerCase("id").includes(query)));
  tableHead.innerHTML = `<tr>${data.columns.map((column) => `<th>${escapeHtml(column)}</th>`).join("")}</tr>`;
  tableBody.innerHTML = rows.map((row) => `<tr>${row.map((value) => `<td>${escapeHtml(value)}</td>`).join("")}</tr>`).join("");
  emptyState.textContent = "Data tidak ditemukan.";
  emptyState.classList.toggle("hidden", rows.length > 0);
  document.querySelector("#tableSummary").textContent = `Menampilkan ${rows.length} data contoh`;
}

function renderDashboard() {
  const now = new Date();
  const thisMonth = orders.filter((order) => {
    const date = new Date(order.receivedAt);
    return date.getFullYear() === now.getFullYear() && date.getMonth() === now.getMonth() && order.status !== "Dibatalkan";
  });
  const customerKeys = new Set(orders.map((order) => order.phone || order.name.trim().toLocaleLowerCase("id")));
  const activeCount = orders.filter((order) => !["Selesai", "Dibatalkan"].includes(order.status)).length;
  const completedCount = orders.filter((order) => order.status === "Selesai").length;
  document.querySelector("#revenueValue").textContent = money(thisMonth.reduce((total, order) => total + order.amount, 0));
  document.querySelector("#revenueOrderCount").textContent = `${thisMonth.length} pemasukan bulan ini`;
  document.querySelector("#activeOrdersValue").innerHTML = `${activeCount} <small>pesanan</small>`;
  document.querySelector("#newCustomersValue").innerHTML = `${customerKeys.size} <small>pelanggan</small>`;
  document.querySelector("#completedOrdersValue").innerHTML = `${completedCount} <small>pesanan</small>`;

  const statusCounts = { Diterima: 0, Dicuci: 0, Dikeringkan: 0, "Siap diambil": 0, Selesai: 0, Dibatalkan: 0 };
  orders.forEach((order) => { statusCounts[order.status] += 1; });
  const activeTotal = Object.values(statusCounts).reduce((sum, count) => sum + count, 0);
  document.querySelector("#donutTotal").textContent = String(activeTotal);
  document.querySelector("#statusReceived").textContent = String(statusCounts.Diterima);
  document.querySelector("#statusWashing").textContent = String(statusCounts.Dicuci);
  document.querySelector("#statusDrying").textContent = String(statusCounts.Dikeringkan);
  document.querySelector("#statusReady").textContent = String(statusCounts["Siap diambil"]);
  document.querySelector("#statusDone").textContent = String(statusCounts.Selesai);
  document.querySelector("#statusCancelled").textContent = String(statusCounts.Dibatalkan);
  const colors = ["#aaa5f4", "#7772eb", "#65b8eb", "#53c79c", "#f2b55c", "#dd8184"];
  let angle = 0;
  const gradientStops = Object.values(statusCounts).map((count, index) => {
    const start = angle;
    angle += activeTotal ? count / activeTotal * 360 : 0;
    return `${colors[index]} ${start}deg ${angle}deg`;
  });
  document.querySelector(".donut-chart").style.background = activeTotal
    ? `conic-gradient(${gradientStops.join(", ")})`
    : "#eceef3";

  const dailyRevenue = Array.from({ length: 7 }, (_, index) => {
    const date = new Date();
    date.setHours(0, 0, 0, 0);
    date.setDate(date.getDate() - 6 + index);
    const key = `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}-${String(date.getDate()).padStart(2, "0")}`;
    const revenue = orders.reduce((total, order) => total + (localDateKey(order.receivedAt) === key && order.status !== "Dibatalkan" ? order.amount : 0), 0);
    return { date, key, revenue };
  });
  const maxRevenue = Math.max(...dailyRevenue.map((day) => day.revenue));
  const chartMaximum = Math.max(3, Math.ceil(maxRevenue / 3) * 3);
  const points = dailyRevenue.map((day, index) => ({
    x: index * (700 / 6),
    y: 194 - day.revenue / chartMaximum * 174,
    label: new Intl.DateTimeFormat("id-ID", { weekday: "short", day: "numeric" }).format(day.date),
    revenue: day.revenue
  }));
  const formatAxis = (amount) => amount === 0 ? "Rp 0" : `Rp ${new Intl.NumberFormat("id-ID", { notation: "compact", maximumFractionDigits: 1 }).format(amount)}`;
  document.querySelector("#chartAxisTop").textContent = formatAxis(chartMaximum);
  document.querySelector("#chartAxisMiddleTop").textContent = formatAxis(chartMaximum * 2 / 3);
  document.querySelector("#chartAxisMiddleBottom").textContent = formatAxis(chartMaximum / 3);
  const path = points.map((point, index) => `${index === 0 ? "M" : "L"}${point.x.toFixed(1)} ${point.y.toFixed(1)}`).join(" ");
  document.querySelector("#chartLine").setAttribute("d", path);
  document.querySelector("#chartArea").setAttribute("d", `${path} L700 194 L0 194 Z`);
  document.querySelector("#chartPoints").innerHTML = points
    .map((point) => `<circle class="chart-point" cx="${point.x.toFixed(1)}" cy="${point.y.toFixed(1)}" r="3.5"><title>${escapeHtml(point.label)}: ${money(point.revenue)}</title></circle>`)
    .join("");
  document.querySelector("#chartLabels").innerHTML = points.map((point) => `<span>${escapeHtml(point.label)}</span>`).join("");
}

function updateProfileUI() {
  const initials = profile.name.trim().split(/\s+/).slice(0, 2).map((part) => part[0]).join("").toUpperCase();
  document.querySelectorAll("[data-admin-name]").forEach((element) => { element.textContent = profile.name; });
  document.querySelectorAll("[data-admin-short-name]").forEach((element) => { element.textContent = profile.name.split(/\s+/)[0]; });
  document.querySelectorAll("[data-admin-initials]").forEach((element) => { element.textContent = initials || "AD"; });
}

function renderCurrentPage() {
  renderDashboard();
  if (activePage === "pelanggan") renderCustomers();
  else if (activePage === "laporan") renderReports();
  else if (activePage === "layanan") renderServices();
  else if (activePage === "stok" || activePage === "pengaturan") renderStaticPage(activePage);
  else renderOrders();
}

function updateNavigation(page) {
  activePage = pageInfo[page] ? page : "dashboard";
  const [title, subtitle] = pageInfo[activePage];
  document.querySelectorAll(".nav-link").forEach((link) => link.classList.toggle("active", link.dataset.page === activePage));
  document.querySelector("#pageTitle").textContent = title;
  document.querySelector("#pageBreadcrumb").textContent = title;
  document.querySelector("#pageSubtitle").textContent = subtitle;
  document.querySelector(".stats-grid").classList.toggle("hidden", !["dashboard", "pesanan"].includes(activePage));
  document.querySelector(".content-grid").classList.toggle("hidden", activePage !== "dashboard");
  document.querySelector(".orders-panel").classList.remove("hidden");
  document.querySelector("#newOrderButton").classList.toggle("hidden", !["dashboard", "pesanan", "riwayat"].includes(activePage));
  document.querySelector("#manageServicesButton").classList.toggle("hidden", activePage !== "layanan");
  document.querySelector("#historyFilters").classList.toggle("hidden", activePage !== "riwayat");
  document.querySelector("#statusFilter").classList.toggle("hidden", ["riwayat", "pelanggan", "layanan", "stok", "laporan", "pengaturan"].includes(activePage));
  document.querySelector("#viewAllButton").classList.toggle("hidden", activePage !== "dashboard");
  document.querySelector(".orders-header h2").textContent = activePage === "dashboard" ? "Pesanan Terbaru" : title;
  document.querySelector(".orders-header p").textContent = activePage === "dashboard" ? "Daftar transaksi laundry terbaru Anda" : subtitle;
  searchInput.value = "";
  activeFilter = "Semua status";
  document.querySelector("#statusFilter").value = activeFilter;
  renderCurrentPage();
}

function openOrderModal(order) {
  if (!services.length) {
    showToast("Tambahkan layanan dan harga sebelum mencatat cucian.");
    return;
  }
  orderForm.reset();
  orderForm.elements.id.value = order ? order.id : "";
  orderForm.elements.customer.value = order ? order.name : "";
  orderForm.elements.phone.value = order ? order.phone : "";
  orderForm.elements.weight.value = order ? order.weight : "";
  updateServiceOptions(order ? order.service : services[0].name);
  orderForm.elements.pricePerKg.value = order
    ? order.pricePerKg
    : services.find((service) => service.name === orderForm.elements.service.value)?.price || 0;
  orderForm.elements.receivedAt.value = localDateTimeValue(order ? order.receivedAt : new Date());
  orderForm.elements.status.value = order ? order.status : "Diterima";
  document.querySelector("#modalTitle").textContent = order ? "Edit Data Cucian" : "Catat Cucian Masuk";
  document.querySelector(".modal-header .eyebrow").textContent = order ? `EDIT PESANAN ${order.id}` : "CUCIAN MASUK";
  document.querySelector("#orderSubmitButton").textContent = order ? "Simpan Perubahan" : "Simpan Pesanan";
  updateOrderPreview();
  modal.classList.remove("hidden");
  orderForm.elements.customer.focus();
}

function updateOrderPreview() {
  const total = Number(orderForm.elements.weight.value) * Number(orderForm.elements.pricePerKg.value);
  document.querySelector("#orderTotalPreview").textContent = `Total cucian: ${money(Number.isFinite(total) ? total : 0)}`;
}

function closeModal(target) {
  target.classList.add("hidden");
}

function openServiceModal(service) {
  const form = document.querySelector("#serviceForm");
  form.reset();
  form.elements.originalName.value = service ? service.name : "";
  form.elements.name.value = service ? service.name : "";
  form.elements.price.value = service ? service.price : "";
  form.elements.turnaround.value = service ? service.turnaround : "";
  document.querySelector("#serviceModalTitle").textContent = service ? "Ubah layanan" : "Tambah layanan";
  serviceModal.classList.remove("hidden");
  form.elements.name.focus();
}

function exportHistory() {
  const filtered = sortedOrders();
  if (!filtered.length) {
    showToast("Tidak ada riwayat yang cocok untuk diekspor.");
    return;
  }
  const headings = ["ID Pesanan", "Nama Pelanggan", "Telepon", "Berat (kg)", "Layanan", "Harga per kg", "Tanggal Masuk", "Total", "Status"];
  const rows = filtered.map((order) => [
    order.id,
    order.name,
    order.phone,
    order.weight,
    order.service,
    order.pricePerKg,
    new Date(order.receivedAt).toLocaleString("id-ID"),
    order.amount,
    order.status
  ]);
  const csvCell = (value) => {
    const safeValue = /^[=+\-@]/.test(String(value)) ? `'${value}` : String(value);
    return `"${safeValue.replaceAll('"', '""')}"`;
  };
  const csv = [headings, ...rows].map((row) => row.map(csvCell).join(",")).join("\r\n");
  const link = document.createElement("a");
  const url = URL.createObjectURL(new Blob(["\uFEFF", csv], { type: "text/csv;charset=utf-8" }));
  link.href = url;
  link.download = `washly-riwayat-${new Date().toISOString().slice(0, 10)}.csv`;
  link.click();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  showToast(`${filtered.length} catatan riwayat berhasil diekspor.`);
}

const now = new Date();
document.querySelector("#currentDate").textContent = new Intl.DateTimeFormat("id-ID", { weekday: "long", day: "numeric", month: "long", year: "numeric" }).format(now);
document.querySelector("#copyrightYear").textContent = String(now.getFullYear());
const hour = now.getHours();
const greeting = hour < 11 ? "SELAMAT PAGI" : hour < 15 ? "SELAMAT SIANG" : hour < 18 ? "SELAMAT SORE" : "SELAMAT MALAM";
document.querySelector("#greeting").textContent = `${greeting} ✨`;

document.querySelectorAll(".nav-link").forEach((link) => {
  link.addEventListener("click", (event) => {
    event.preventDefault();
    const page = link.dataset.page;
    history.replaceState(null, "", `#${page}`);
    updateNavigation(page);
    document.querySelector("#sidebar").classList.remove("open");
    document.querySelector("#mobileOverlay").classList.remove("visible");
  });
});
document.querySelectorAll("[data-go]").forEach((button) => {
  button.addEventListener("click", () => document.querySelector(`.nav-link[data-page="${button.dataset.go}"]`).click());
});
searchInput.addEventListener("input", renderCurrentPage);
document.querySelector("#statusFilter").addEventListener("change", (event) => {
  activeFilter = event.currentTarget.value;
  renderOrders();
});
document.querySelector("#dateFrom").addEventListener("change", renderOrders);
document.querySelector("#dateTo").addEventListener("change", renderOrders);
document.querySelector("#exportHistoryButton").addEventListener("click", exportHistory);
document.querySelector("#newOrderButton").addEventListener("click", () => openOrderModal());
document.querySelector("#closeModal").addEventListener("click", () => closeModal(modal));
document.querySelector("#cancelModal").addEventListener("click", () => closeModal(modal));
document.querySelector("#closeAccountModal").addEventListener("click", () => closeModal(accountModal));
document.querySelector("#cancelAccountModal").addEventListener("click", () => closeModal(accountModal));
document.querySelectorAll(".modal-backdrop").forEach((backdrop) => backdrop.addEventListener("click", (event) => {
  if (event.target === backdrop) closeModal(backdrop);
}));
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape") document.querySelectorAll(".modal-backdrop:not(.hidden)").forEach(closeModal);
});

orderForm.elements.service.addEventListener("change", () => {
  orderForm.elements.pricePerKg.value = services.find((service) => service.name === orderForm.elements.service.value)?.price || "";
  updateOrderPreview();
});
orderForm.elements.weight.addEventListener("input", updateOrderPreview);
orderForm.elements.pricePerKg.addEventListener("input", updateOrderPreview);
orderForm.addEventListener("submit", async (event) => {
  event.preventDefault();
  const name = orderForm.elements.customer.value.trim();
  const phone = orderForm.elements.phone.value.trim();
  const weight = Number(orderForm.elements.weight.value);
  const pricePerKg = Number(orderForm.elements.pricePerKg.value);
  const receivedAt = new Date(orderForm.elements.receivedAt.value);
  const service = orderForm.elements.service.value;
  const status = orderForm.elements.status.value;
  if (!name || !phone || !Number.isFinite(weight) || weight <= 0 || !Number.isFinite(pricePerKg) || pricePerKg <= 0 || Number.isNaN(receivedAt.getTime())) {
    showToast("Periksa nama, nomor telepon, berat, harga, dan tanggal masuk.");
    return;
  }
  const existingId = orderForm.elements.id.value;
  const existingOrder = orders.find((order) => order.id === existingId);
  const order = {
    id: existingOrder ? existingOrder.id : "",
    name,
    phone,
    service,
    weight,
    pricePerKg,
    amount: Math.round(weight * pricePerKg),
    status,
    receivedAt: receivedAt.toISOString()
  };
  try {
    const saved = await apiRequest("save_order", { order });
    await refreshData();
    closeModal(modal);
    showToast(existingOrder ? "Data cucian berhasil diperbarui." : `Cucian masuk berhasil dicatat (${saved.id}).`);
  } catch (error) {
    console.error("Data cucian gagal disimpan di database.", error);
    showToast(error.message);
  }
});

tableBody.addEventListener("change", async (event) => {
  const select = event.target.closest(".row-status-select");
  if (!select) return;
  const order = orders.find((item) => item.id === select.dataset.orderId);
  if (!order || !statuses.includes(select.value) || order.status === select.value) return;
  const updated = { ...order, status: select.value, statusHistory: [...order.statusHistory, { status: select.value, changedAt: new Date().toISOString() }] };
  try {
    await apiRequest("change_status", { id: order.id, status: updated.status });
    await refreshData();
    showToast(`Status cucian diubah menjadi ${updated.status}.`);
  } catch (error) {
    console.error("Status cucian tidak dapat diperbarui.", error);
    showToast(error.message);
    await refreshData();
  }
});
tableBody.addEventListener("click", async (event) => {
  const editButton = event.target.closest("[data-edit-order]");
  const deleteButton = event.target.closest("[data-delete-order]");
  const editServiceButton = event.target.closest("[data-edit-service]");
  const deleteServiceButton = event.target.closest("[data-delete-service]");
  if (editServiceButton) {
    const service = services.find((item) => item.name === editServiceButton.dataset.editService);
    if (service) openServiceModal(service);
  }
  if (deleteServiceButton) {
    const serviceName = deleteServiceButton.dataset.deleteService;
    if (orders.some((order) => order.service === serviceName)) {
      showToast("Layanan ini masih tercatat dalam riwayat cucian dan tidak dapat dihapus.");
      return;
    }
    if (services.length === 1) {
      showToast("Minimal harus tersedia satu layanan.");
      return;
    }
    if (window.confirm(`Hapus layanan "${serviceName}" dari daftar harga?`)) {
      try {
        await apiRequest("delete_service", { name: serviceName });
        await refreshData();
        showToast("Layanan berhasil dihapus.");
      } catch (error) {
        console.error("Layanan gagal dihapus.", error);
        showToast(error.message);
      }
    }
  }
  if (editButton) {
    const order = orders.find((item) => item.id === editButton.dataset.editOrder);
    if (order) openOrderModal(order);
  }
  if (deleteButton) {
    const order = orders.find((item) => item.id === deleteButton.dataset.deleteOrder);
    if (!order || !window.confirm(`Hapus catatan cucian ${order.id} untuk ${order.name}? Tindakan ini tidak dapat dibatalkan.`)) return;
    try {
      await apiRequest("delete_order", { id: order.id });
      await refreshData();
      showToast(`Catatan ${order.id} berhasil dihapus.`);
    } catch (error) {
      console.error("Catatan cucian gagal dihapus.", error);
      showToast(error.message);
    }
  }
});

document.querySelector("#menuToggle").addEventListener("click", () => {
  document.querySelector("#sidebar").classList.add("open");
  document.querySelector("#mobileOverlay").classList.add("visible");
});
document.querySelector("#mobileOverlay").addEventListener("click", () => {
  document.querySelector("#sidebar").classList.remove("open");
  document.querySelector("#mobileOverlay").classList.remove("visible");
});
document.querySelector("#notificationButton").addEventListener("click", () => showToast("Tidak ada notifikasi baru."));
document.querySelectorAll("#profileButton, #topbarUser").forEach((button) => button.addEventListener("click", () => {
  const form = document.querySelector("#accountForm");
  form.elements.username.value = profile.username;
  form.elements.name.value = profile.name;
  form.elements.phone.value = profile.phone || "";
  form.elements.currentPassword.value = "";
  form.elements.newPassword.value = "";
  accountModal.classList.remove("hidden");
}));
document.querySelector("#accountForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const nextProfile = {
    username: form.elements.username.value.trim(),
    name: form.elements.name.value.trim(),
    phone: form.elements.phone.value.trim(),
    currentPassword: form.elements.currentPassword.value,
    newPassword: form.elements.newPassword.value
  };
  if (!nextProfile.name || !nextProfile.currentPassword) {
    showToast("Nama administrator dan kata sandi saat ini wajib diisi.");
    return;
  }
  try {
    const result = await apiRequest("save_account", nextProfile);
    csrfToken = result.csrfToken;
    document.querySelector("#logoutCsrf").value = csrfToken;
    profile = result.profile;
    updateProfileUI();
    document.querySelector("#greeting").textContent = `${greeting}, ${profile.name.split(/\s+/)[0]} ✨`;
    closeModal(accountModal);
    showToast("Profil dan akun administrator berhasil diperbarui.");
  } catch (error) {
    console.error("Profil administrator gagal diperbarui.", error);
    showToast(error.message);
  }
});
document.querySelector("#viewAllButton").addEventListener("click", () => document.querySelector('.nav-link[data-page="pesanan"]').click());
document.querySelector("#manageServicesButton").addEventListener("click", () => openServiceModal());
document.querySelector("#closeServiceModal").addEventListener("click", () => closeModal(serviceModal));
document.querySelector("#cancelServiceModal").addEventListener("click", () => closeModal(serviceModal));
document.querySelector("#serviceForm").addEventListener("submit", async (event) => {
  event.preventDefault();
  const form = event.currentTarget;
  const originalName = form.elements.originalName.value;
  const service = {
    name: form.elements.name.value.trim(),
    price: Number(form.elements.price.value),
    turnaround: form.elements.turnaround.value.trim()
  };
  if (!service.name || !service.turnaround || !Number.isFinite(service.price) || service.price <= 0) {
    showToast("Lengkapi nama, harga, dan estimasi layanan dengan benar.");
    return;
  }
  const duplicate = services.some((item) => item.name.toLocaleLowerCase("id") === service.name.toLocaleLowerCase("id") && item.name !== originalName);
  if (duplicate) {
    showToast("Nama layanan tersebut sudah ada.");
    return;
  }
  try {
    await apiRequest("save_service", { ...service, originalName });
    await refreshData();
    closeModal(serviceModal);
    showToast(originalName ? "Harga dan informasi layanan berhasil diperbarui." : "Layanan baru berhasil ditambahkan.");
  } catch (error) {
    console.error("Layanan gagal disimpan.", error);
    showToast(error.message);
  }
});
document.querySelector("#shareButton").addEventListener("click", () => {
  if (!["http:", "https:"].includes(window.location.protocol)) {
    showToast("Tautan WhatsApp tersedia setelah website diunggah ke hosting HTTPS.");
    return;
  }
  const hostname = window.location.hostname.replace(/^\[|\]$/g, "");
  const isPrivateAddress = /^(localhost|(?:127|10)\.\d{1,3}\.\d{1,3}\.\d{1,3}|192\.168\.\d{1,3}\.\d{1,3}|172\.(?:1[6-9]|2\d|3[01])\.\d{1,3}\.\d{1,3}|169\.254\.\d{1,3}\.\d{1,3}|::1)$/i.test(hostname);
  if (isPrivateAddress || hostname.endsWith(".local") || /^\d{1,3}(?:\.\d{1,3}){3}$/.test(hostname)) {
    showToast("Unggah website ke domain publik terlebih dahulu sebelum membagikan tautan WhatsApp.");
    return;
  }
  const message = `Lihat website Washly Laundry: ${window.location.href}`;
  window.open(`https://wa.me/?text=${encodeURIComponent(message)}`, "_blank", "noopener,noreferrer");
});

const initialPage = location.hash.slice(1);
updateNavigation(pageInfo[initialPage] ? initialPage : "dashboard");
refreshData(true);
window.setInterval(() => {
  const anyDialogOpen = [...document.querySelectorAll(".modal-backdrop")].some((element) => !element.classList.contains("hidden"));
  if (!document.hidden && !anyDialogOpen) refreshData();
}, 15000);
window.addEventListener("focus", () => {
  const anyDialogOpen = [...document.querySelectorAll(".modal-backdrop")].some((element) => !element.classList.contains("hidden"));
  if (!anyDialogOpen) refreshData();
});
