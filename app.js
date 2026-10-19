(() => {
  "use strict";
  const $ = (s) => document.querySelector(s),
    $$ = (s) => [...document.querySelectorAll(s)];
  const escape = (s) =>
    String(s ?? "").replace(
      /[&<>"']/g,
      (c) =>
        ({
          "&": "&amp;",
          "<": "&lt;",
          ">": "&gt;",
          '"': "&quot;",
          "'": "&#39;",
        })[c],
    );
  const fmt = (v, d = 0) =>
    Number(v).toLocaleString("vi-VN", {
      maximumFractionDigits: d,
      minimumFractionDigits: d,
    });
  // Số có tối đa d chữ số thập phân, không ép số 0 thừa (6,5 % thay vì 7 %).
  const num = (v, d = 2) =>
    Number(v).toLocaleString("vi-VN", { maximumFractionDigits: d });
  const pct = (v) => num(v, 2) + "%";
  /**
   * Đọc số theo thói quen Việt Nam: "1.500.000", "1.500" (nghìn), "2,5", "-1.250,75".
   * Một dấu chấm theo sau đúng 3 chữ số được hiểu là phân cách hàng nghìn.
   */
  function parseNumberVN(input) {
    let s = String(input ?? "").trim().replace(/[\s₫đ]|VND|USD/gi, "");
    if (!s) return NaN;
    const sign = /^[-−]/.test(s) ? -1 : 1;
    s = s.replace(/^[-−+]/, "");
    if (!/^[\d.,]+$/.test(s)) return NaN;
    const dots = (s.match(/\./g) || []).length, commas = (s.match(/,/g) || []).length;
    if (dots && commas) {
      // Dấu xuất hiện sau cùng là dấu thập phân.
      s = s.lastIndexOf(",") > s.lastIndexOf(".") ? s.replace(/\./g, "").replace(",", ".") : s.replace(/,/g, "");
    } else if (commas) s = commas > 1 ? s.replace(/,/g, "") : s.replace(",", ".");
    else if (dots > 1 || /^\d{1,3}\.\d{3}$/.test(s)) s = s.replace(/\./g, "");
    if (!/^(\d+\.?\d*|\.\d+)$/.test(s)) return NaN;
    return sign * Number(s);
  }
  const money = (v, c = project()?.currency || "VND") =>
    fmt(v, c === "USD" ? 2 : 0) + " " + (c === "VND" ? "₫" : c);
  const shortMoney = (v, c = project()?.currency || "VND") =>
    c === "USD"
      ? fmt(v, 0) + " USD"
      : Math.abs(v) >= 1e9
        ? fmt(v / 1e9, 2) + " tỷ"
        : Math.abs(v) >= 1e6
          ? fmt(v / 1e6, 1) + " tr"
          : fmt(v) + " ₫";
  const dateLabel = (s) => (s ? s.split("-").reverse().join("/") : "—");
  const copy = (o) => JSON.parse(JSON.stringify(o));
  const uid = () => crypto.randomUUID();
  const KEY = "nen.workspace.v1";
  let storageOK = true,
    db;
  /** Bổ sung trường còn thiếu cho dữ liệu cũ hoặc nhập từ JSON để giao diện không vỡ. */
  function normalizeProject(p) {
    if (!p || typeof p !== "object") return p;
    const base = Samples.empty();
    for (const key of ["tasks", "boq", "risks", "history"]) if (!Array.isArray(p[key])) p[key] = [];
    if (!Array.isArray(p.workdays) || !p.workdays.length) p.workdays = base.workdays;
    if (!Array.isArray(p.holidays)) p.holidays = [];
    p.estimate = { ...base.estimate, profit: 0, ...(p.estimate || {}) };
    p.finance = { ...base.finance, ...(p.finance || {}) };
    for (const key of ["statusDay", "capacity", "indirectBase", "dailySaving"])
      if (typeof p[key] !== "number") p[key] = base[key];
    return p;
  }
  function loadWorkspace(raw) {
    const data = JSON.parse(raw || "null");
    if (!data || data.schema !== 1 || !Array.isArray(data.projects) || !data.projects.length) return null;
    data.projects = data.projects.filter((p) => p && typeof p === "object").map(normalizeProject);
    return data.projects.length ? data : null;
  }
  let stored = null;
  try {
    stored = localStorage.getItem(KEY);
  } catch {
    storageOK = false;
  }
  try {
    db = loadWorkspace(stored);
  } catch {
    db = null;
  }
  if (!db) {
    // Giữ bản hỏng để có thể khôi phục thủ công thay vì ghi đè mất dữ liệu.
    if (stored) {
      try {
        localStorage.setItem(KEY + ".backup-" + Date.now(), stored);
      } catch {}
    }
    db = { schema: 1, projects: [Samples.construction()], selected: null };
    db.selected = db.projects[0].id;
  }
  if (!db.projects.some((p) => p.id === db.selected)) db.selected = db.projects[0].id;
  // Bài tập từ Dữ liệu QLDA.docx luôn có sẵn (trừ khi người dùng đã xóa).
  for (const [id, make] of [['nhom-quan-ly-du-an', Samples.group], ['bai-tap-a-k', Samples.exerciseAK]])
    if (!db.projects.some((p) => p.id === id) && !db.deletedSamples?.includes(id)) db.projects.push(make());
  let mode = null,
    page = "overview",
    scheduleTab = "gantt",
    search = "",
    criticalOnly = false,
    scene = null,
    sceneDay = 0,
    sceneTimer = null,
    optimization = null,
    modalHandler = null,
    team = null,
    serverAvailable = false,
    toastTimer,
    heroProgress = 0.65;
  let heroScene = new BuildScene($("#hero-canvas"), () => heroProgress);
  const PHASES = [
    "Chuẩn bị hạ tầng ngoài",
    "Tổ chức mặt bằng",
    "Thi công phần ngầm",
    "Thi công móng",
    "Kết cấu phần thân",
    "Hoàn thiện",
    "Nghiệm thu · bàn giao",
  ];
  const phaseFor = (t) =>
    Number.isInteger(t.stage)
      ? t.stage
      : ({ A: 1, B: 3, C: 4, D: 4, E: 5, F: 5, G: 5, H: 6, I: 1 }[t.id] ?? 4);
  function project() {
    return db.projects.find((p) => p.id === db.selected) || db.projects[0];
  }
  function calc() {
    return Planner.active(project());
  }
  function save() {
    if (!team) {
      try {
        localStorage.setItem(KEY, JSON.stringify(db));
        storageOK = true;
      } catch {
        storageOK = false;
        toast(
          "Trình duyệt không lưu được dữ liệu. Hãy xuất JSON để giữ bản sao.",
          true,
        );
      }
    }
    if ($("#save-state"))
      $("#save-state").textContent = team
        ? "Đã đồng bộ không gian chung"
        : storageOK
          ? "Lưu trên trình duyệt"
          : "Chưa lưu · hãy xuất JSON";
  }
  function toast(message, error = false) {
    const e = $("#toast");
    e.textContent = message;
    e.className = "show" + (error ? " error" : "");
    clearTimeout(toastTimer);
    toastTimer = setTimeout(() => (e.className = ""), error ? 6500 : 3500);
  }
  const paths = {
    portfolio: "M3 3h7v7H3z M14 3h7v7h-7z M3 14h7v7H3z M14 14h7v7h-7z",
    overview: "M3 3v18h18 M7 16v-5 M12 16V6 M17 16v-8",
    model: "M12 2 2 7l10 5 10-5-10-5z M2 7v10l10 5 10-5V7 M12 12v10",
    schedule: "M4 4h16v17H4z M8 2v4 M16 2v4 M7 10h6 M10 14h7 M8 18h4",
    network: "M3 9h6v6H3z M16 2h6v6h-6z M16 17h6v6h-6z M9 12h4V5h3 M13 12v8h3",
    estimate:
      "M5 2h14v20H5z M8 6h8 M8 10h2 M14 10h2 M8 14h2 M14 14h2 M8 18h2 M14 18h2",
    costs: "M3 18 9 12l4 3 8-12 M16 3h5v5 M3 22h18",
    finance: "M3 6h18v14H3z M3 10h18 M16 14h3 M7 4h10",
    resources:
      "M9 11a4 4 0 1 0 0-8 4 4 0 0 0 0 8z M2 22v-4c0-5 14-5 14 0v4 M17 3a4 4 0 0 1 0 8 M19 14c3 0 3 3 3 7",
    risk: "M12 2 1 21h22L12 2z M12 8v6 M12 17v1",
    team: "M12 3 2 8v13h20V8L12 3z M8 21v-8h8v8 M5 9h2 M17 9h2",
  };
  const icon = (name) =>
    `<svg viewBox="0 0 24 24" aria-hidden="true"><path d="${paths[name] || paths.overview}" stroke-linecap="round" stroke-linejoin="round"/></svg>`;
  const names = {
    portfolio: "Danh mục dự án",
    overview: "Tổng quan",
    model: "Thi công 3D",
    schedule: "Tiến độ & đường găng",
    network: "Sơ đồ mạng",
    estimate: "Dự toán khối lượng",
    costs: "Chi phí & tối ưu",
    finance: "Tài chính & lãi vay",
    resources: "Nguồn lực",
    risk: "Rủi ro",
    team: "Thành viên & lịch sử",
    guide: "Hướng dẫn & cơ sở tính",
    print: "In & xuất",
  };
  function navigation() {
    const items =
      mode === "business"
        ? [
            "portfolio",
            "overview",
            "model",
            "schedule",
            "network",
            "estimate",
            "costs",
            "finance",
            "resources",
            "risk",
            "team",
          ]
        : [
            "overview",
            "model",
            "schedule",
            "network",
            "estimate",
            "costs",
            "finance",
            "resources",
            "risk",
          ];
    if(!items.includes("team"))items.push("team");
    items.push("print");
    $("#side-nav").innerHTML = DOMPurify.sanitize(
      items
        .map(
          (k) =>
            `<button data-page="${k}" class="${page === k ? "active" : ""}" ${page === k ? 'aria-current="page"' : ""}>${icon(k)}<span>${names[k]}</span></button>`,
        )
        .join(""),
    );
    $("#mode-switch").innerHTML = DOMPurify.sanitize(
      (mode === "business" ? "⌘ Đội dự án" : "↗ Cá nhân") + "<b>⇄</b>",
    );
    $("#workspace-label").textContent =
      mode === "business" ? "Không gian đội dự án" : "Không gian cá nhân";
    $("#project-select").innerHTML = DOMPurify.sanitize(
      db.projects
        .map(
          (p) =>
            `<option value="${escape(p.id)}" ${p.id === project().id ? "selected" : ""}>${escape(p.name)}</option>`,
        )
        .join(""),
    );
    $("#access-badge").textContent = team
      ? project()._role === "viewer"
        ? "Chỉ xem"
        : "Đã kết nối"
      : "Cục bộ";
    $("#save-state").textContent = team
      ? "Dữ liệu trên máy chủ"
      : storageOK
        ? "Lưu trên trình duyệt"
        : "Chưa lưu · hãy xuất JSON";
    const avatar = $(".topbar-actions .avatar, button.avatar");
    if (avatar) {
      // Chữ viết tắt của tài khoản đang đăng nhập; chế độ cá nhân hiện "CN".
      const words = (team?.name || "").trim().split(/\s+/).filter(Boolean);
      avatar.textContent = words.length ? (words.length > 1 ? words[0][0] + words[words.length - 1][0] : words[0].slice(0, 2)).toUpperCase() : "CN";
      avatar.title = team ? "Tài khoản: " + team.name : "Chế độ cá nhân · bấm để kết nối đội dự án";
    }
    $("#footer-calendar").textContent =
      `Lịch ${project().workdays.length} ngày/tuần · Thời lượng & lag theo ngày làm việc`;
  }
  let sessionUser = null;
  function chooseMode(value) {
    mode = value;
    // Còn phiên đăng nhập đội dự án: vào thẳng dữ liệu máy chủ thay vì âm thầm sửa bản cục bộ.
    if (value === "business" && sessionUser && !team) {
      const user = sessionUser;
      sessionUser = null;
      loadTeam(user).then(() => toast("Đã khôi phục phiên đăng nhập của " + user.name)).catch((e) => toast(e.message, true));
    }
    page = value === "business" ? "portfolio" : "overview";
    $("#landing").hidden = true;
    $("#app").hidden = false;
    heroScene?.destroy();
    heroScene = null;
    window.scrollTo(0, 0);
    render();
  }
  function home() {
    clearScene();
    $("#app").hidden = true;
    $("#landing").hidden = false;
    mode = null;
    heroScene?.destroy();
    heroScene = new BuildScene($("#hero-canvas"), () => heroProgress);
    window.scrollTo({ top: 0, behavior: "smooth" });
  }
  function clearScene() {
    scene?.destroy();
    scene = null;
    clearInterval(sceneTimer);
    sceneTimer = null;
  }
  let routeTransition = null;
  function transitionView(change) {
    if (matchMedia("(prefers-reduced-motion: reduce)").matches) {
      change();
      return;
    }
    if (document.startViewTransition) {
      routeTransition?.skipTransition();
      routeTransition = document.startViewTransition(change);
      for (const promise of [routeTransition.ready, routeTransition.finished, routeTransition.updateCallbackDone]) promise?.catch(() => {});
    } else {
      change();
      window.Motion?.animate(
        "#main",
        { opacity: [0.3, 1], y: [10, 0] },
        { duration: 0.45, ease: "easeOut" },
      );
    }
  }
  function render() {
    clearScene();
    navigation();
    try {
      $("#main").innerHTML = DOMPurify.sanitize(
        (
          {
            overview: overviewView,
            portfolio: portfolioView,
            model: modelView,
            schedule: scheduleView,
            network: networkView,
            estimate: estimateView,
            costs: costsView,
            finance: financeView,
            resources: resourcesView,
            risk: riskView,
            team: teamView,
            guide: guideView,
            print: printView,
          }[page] || overviewView
        )(),
      );
      if (page === "model") mountScene();
      if (page === "team" && team) loadComments();
      if (page === "network") mountGraphEditor();
    } catch (e) {
      $("#main").innerHTML = DOMPurify.sanitize(
        `<div class="error-page"><h2>Kiểm tra dữ liệu dự án</h2><p>${escape(e.message)}</p><button class="btn ghost" data-action="import">Nhập bản sao JSON</button></div>`,
      );
      console.error(e);
    }
    $$("tr.click-row").forEach((row) => {
      row.tabIndex = 0;
      row.setAttribute(
        "aria-label",
        "Mở chi tiết " + (row.cells[0]?.textContent.trim() || "công việc"),
      );
    });
    syncSidebar();
    $("#side-nav")
      .querySelector(".active")
      ?.scrollIntoView({ block: "nearest" });
  }
  function syncSidebar() {
    const sidebar = $(".sidebar"),
      closed =
        matchMedia("(max-width:760px)").matches &&
        !sidebar.classList.contains("open");
    sidebar.inert = closed;
    sidebar.setAttribute("aria-hidden", String(closed));
    $("#mobile-menu").setAttribute("aria-expanded", String(!closed));
  }
  const heading = (title, description, actions = "") =>
    `<div class="page-heading"><div><p class="eyebrow">${mode === "business" ? "ĐIỀU HÀNH DỰ ÁN" : "KHÔNG GIAN CÁ NHÂN"} / ${escape(project().name)}</p><h1>${title}</h1><p>${description}</p></div><div class="heading-actions">${actions}</div></div>`;
  const kpi = (label, value, sub = "", type = "", unit = "") =>
    `<article class="kpi ${type}"><div class="kpi-title">${label}<span class="kpi-icon">↗</span></div><div class="kpi-value">${value}${unit ? `<small>${unit}</small>` : ""}</div><div class="kpi-sub">${sub}</div></article>`;
  const panel = (title, sub, body, tools = "") =>
    `<section class="panel"><div class="panel-head"><div><h2>${title}</h2>${sub ? `<p>${sub}</p>` : ""}</div><div class="panel-tools">${tools}</div></div>${body}</section>`;
  const legend = () =>
    '<div class="legend"><span><i class="red"></i>Công việc găng</span><span><i></i>Công việc thường</span><span><i class="dash"></i>Dự trữ toàn phần</span></div>';
  const primaryAdd = () =>
    '<button class="btn primary" data-action="add-task">+ Thêm công việc</button>';
  /** Ngày lịch của mốc ngày làm việc (mốc 0 = đầu ngày khởi công), có trừ ngày lễ. */
  const workDate = (p, offset) => CT.dateAt(p.start, Math.max(0, offset), p.workdays, p.holidays);
  function finishDate(p, r) {
    return dateLabel(workDate(p, r.duration - 1));
  }
  /** Khoảng ngày thực hiện của công tác: từ ngày ES đến ngày làm việc cuối (EF − 1). */
  function taskDates(p, t) {
    const start = workDate(p, t.es);
    return t.duration > 1 ? dateLabel(start) + " – " + dateLabel(workDate(p, t.ef - 1)) : dateLabel(start);
  }
  function overviewView() {
    const p = project(),
      r = calc(),
      e = CT.evm(r.rows, p.statusDay),
      progress = e.bac
        ? (e.ev / e.bac) * 100
        : r.duration
          ? r.rows.reduce((s, t) => s + t.duration * t.progress, 0) /
            r.rows.reduce((s, t) => s + t.duration, 0)
          : 0,
      over = resourceDays(r).filter((x) => x.people > p.capacity).length;
    return (
      heading(
        "Tổng quan dự án",
        "Thời gian, đường găng, chi phí và rủi ro của công trình ở một nơi.",
        `<button class="btn ghost" data-action="export">↓ Xuất dữ liệu</button>${primaryAdd()}`,
      ) +
      `<div class="plan-flow"><span>01 · Nhập ${p.tasks.length} công tác</span><span>02 · Chọn cách xếp</span><span>03 · Đường găng & chi phí</span><button class="btn primary small" data-schedule-tab="planner">Nhập xong · Chọn cách xếp ↗</button></div>` +
      `<div class="kpi-grid">${kpi("Thời gian dự án", r.duration, "Hoàn thành dự kiến " + finishDate(p, r), "accent", "ngày")}${kpi("Công việc găng", r.critical.length, "Trong tổng số " + p.tasks.length + " công việc", "danger")}${kpi("Ngân sách công việc", shortMoney(e.bac), "Chi phí thực tế: " + shortMoney(e.ac))}${kpi("Khối lượng hoàn thành", fmt(progress, 1), "Theo trọng số ngân sách công việc", "", "%")}</div>` +
      `<div class="grid-two">${panel("Tiến độ tổng thể", "Kế hoạch sớm nhất · bấm thanh để sửa công việc", `<div class="table-scroll">${gantt(r, true)}</div><div class="data-note">${legend()}</div>`, `<button class="text-link" data-page="schedule">Xem chi tiết ↗</button>`)}${panel("Cần bạn chú ý", "Các tín hiệu từ dữ liệu hiện tại", `<div class="panel-body"><div class="notice"><i class="notice-dot"></i><div><strong>${r.critical.length} công việc có dự trữ bằng 0</strong><p>${r.critical.length ? r.critical.map(escape).join(" · ") : "Thêm công việc để tính đường găng."}</p></div></div><div class="notice"><i class="notice-dot"></i><div><strong>${over ? over + " ngày vượt năng lực nhân công" : "Nhân công trong giới hạn đã đặt"}</strong><p>Năng lực ${fmt(p.capacity)} người/ngày. Chọn Xếp & tối ưu để tìm lịch theo năng lực.</p></div></div><div class="notice"><i class="notice-dot"></i><div><strong>${p.risks.filter((x) => x.probability * x.impact >= 15 && x.status !== "Đã đóng").length} rủi ro cần ưu tiên</strong><p>Điểm = xác suất × tác động (mỗi trục 1–5, tối đa 25); ưu tiên khi ≥ 15.</p></div></div><button class="btn ghost small" data-page="model">Xem công trình theo thời gian ↗</button></div>`)}</div>` +
      `<div class="grid-two equal-columns">${panel("Kiểm soát tiến độ & chi phí", "Báo cáo tại cuối ngày làm việc thứ " + p.statusDay + (p.statusDay > 0 ? " · " + dateLabel(workDate(p, p.statusDay - 1)) : ""), `<div class="panel-body"><div class="split-info"><div><p class="muted">Chỉ số tiến độ SPI</p><div class="info-number">${e.spi === null ? "—" : fmt(e.spi, 2)}</div></div><div><p class="muted">Chỉ số chi phí CPI</p><div class="info-number">${e.cpi === null ? "—" : fmt(e.cpi, 2)}</div></div><button class="text-link" data-page="costs">Phân tích EVM ↗</button></div><p class="form-caption">PV phân bổ tuyến tính theo thời lượng. Cập nhật % hoàn thành và chi phí thực tế của công việc để đọc các chỉ số.</p></div>`)}${panel("Nhật ký thay đổi gần đây", "Theo dõi các quyết định của dự án", historyHTML(p.history.slice(0, 3)), `<button class="text-link" data-page="team">Xem tất cả ↗</button>`)}</div>`
    );
  }
  function portfolioView() {
    const ps = db.projects,
      all = ps.map((p) => ({ p, r: Planner.active(p) })),
      total = ps.reduce((s, p) => s + p.tasks.length, 0);
    return (
      heading(
        "Danh mục dự án",
        "Quản lý danh mục dự án và đi sâu vào công trình cần bạn chú ý.",
        `<button class="btn ghost" data-action="team-connect">⌘ ${team ? "Tài khoản" : "Kết nối đội dự án"}</button><button class="btn primary" data-action="new-project">+ Tạo dự án</button>`,
      ) +
      `<div class="kpi-grid">${kpi("Dự án trong không gian", ps.length, "Mở một dự án để xem chi tiết", "accent")}${kpi("Tổng công việc", total, "Phân công theo người phụ trách")}${kpi(
        "Công việc găng",
        all.reduce((s, x) => s + x.r.critical.length, 0),
        "Tổng từ các dự án",
        "danger",
      )}${kpi("Cách lưu dữ liệu", team ? "Chung" : "Cục bộ", team ? "Có tài khoản và phân quyền" : "Có thể kết nối máy chủ để cộng tác")}</div>` +
      (!team
        ? '<div class="callout">Bạn đang xem danh mục trên trình duyệt này. Chọn <strong>Kết nối đội dự án</strong> khi chạy bằng máy chủ đi kèm để đăng nhập, chia sẻ dự án, phân quyền và lưu lịch sử trên máy chủ.</div>'
        : "") +
      `<div class="project-cards">${all
        .map(
          ({ p, r }) =>
            `<button class="project-card" data-open-project="${escape(p.id)}"><div class="project-art">DỰ ÁN XÂY DỰNG · ${escape(p.currency)}<p class="member-count">${new Set(p.tasks.map((t) => t.owner).filter(Boolean)).size} người phụ trách</p></div><div class="project-card-body"><span class="badge ${r.critical.length ? "warning" : "neutral"}">${r.critical.length} công việc găng</span><h3>${escape(p.name)}</h3><div class="project-card-meta"><span>${r.duration} ngày làm việc</span><span>${shortMoney(
              p.tasks.reduce((s, t) => s + t.cost, 0),
              p.currency,
            )}</span></div></div></button>`,
        )
        .join("")}</div>` +
      `<div style="margin-top:25px" class="heading-actions"><button class="btn ghost small" data-action="sample-construction">+ Mẫu công trình</button><button class="btn ghost small" data-action="sample-textbook">+ Bài mẫu CPM</button><button class="btn ghost small" data-action="import">↑ Nhập JSON</button></div>`
    );
  }
  function gantt(r, compact = false) {
    if (!r.rows.length)
      return empty(
        "Bắt đầu từ công việc đầu tiên",
        "Thêm mã, thời lượng và quan hệ trước–sau để web tính tiến độ.",
        "add-task",
        "+ Thêm công việc",
      );
    const p = project(),
      total = Math.max(1, r.duration),
      limit = 10,
      display = compact ? r.rows.slice(0, limit) : filteredRows(r.rows),
      { day, step } = ganttScale(total),
      den = total + 0.5,
      at = (v) => (v / den) * 100,
      ticks = [];
    for (let i = 0; i <= total; i += step)
      ticks.push(`<span class="gantt-tick" style="left:${at(i)}%">${i}</span>`);
    const baseline = new Map((p.baseline?.rows || []).map((t) => [t.id, t]));
    const status = p.statusDay <= total ? `<i class="gantt-status" style="left:${at(p.statusDay)}%"></i>` : "";
    const rows = display.map((t) => {
      const id = escape(t.id), dates = taskDates(p, t), base = baseline.get(t.id);
      const float = t.tf > 0 ? `<div class="gantt-float" style="left:${at(t.ef)}%;width:${at(t.tf)}%" title="Dự trữ toàn phần ${t.tf} ngày"></div>` : "";
      const planned = base ? `<div class="baseline-bar" style="left:${at(base.es)}%;width:${Math.max(0.2, at(base.ef - base.es))}%" title="Kế hoạch gốc ${base.es} → ${base.ef}"></div>` : "";
      const info = `${t.name} · ${dates} · ES ${t.es} → EF ${t.ef} · TF ${t.tf}${t.progress ? " · hoàn thành " + num(t.progress, 1) + "%" : ""}`;
      return `<div class="gantt-row${t.critical ? " is-critical" : ""}"><button class="gantt-label" data-edit-task="${id}" title="${escape(t.name)}"><small>${id}</small><span>${escape(t.name)}</span></button><div class="gantt-track">${float}${planned}<button class="gantt-bar ${t.critical ? "critical" : ""}${t.duration === 0 ? " milestone" : ""}" data-edit-task="${id}" style="left:${at(t.es)}%;width:${t.duration ? Math.max(0.35, at(t.duration)) : 0}%" title="${escape(info)}" aria-label="${escape(info)}"><span class="bar-progress" style="width:${Math.min(100, t.progress)}%"></span><span>${t.duration === 0 ? "◆" : t.duration + "n"}</span></button>${status}</div></div>`;
    });
    const more = compact && r.rows.length > limit ? `<div class="gantt-more"><button class="text-link" data-page="schedule">+ ${r.rows.length - limit} công việc khác · xem toàn bộ Gantt</button></div>` : "";
    return `<div class="gantt" style="--grid:${at(day >= 12 ? 1 : step)}%;--day:${day}px;min-width:calc(var(--gantt-label-width,260px) + ${Math.ceil(den * day)}px)"><div class="gantt-header"><div class="gantt-label">CÔNG VIỆC · NGÀY LÀM VIỆC →</div><div class="gantt-track">${ticks.join("")}</div></div>${rows.join("")}</div>${more}`;
  }
  /** Bề rộng 1 ngày trên Gantt theo độ dài tiến độ: vừa màn hình, nhãn trục không chồng nhau. */
  function ganttScale(total) {
    const day = total <= 30 ? 28 : total <= 60 ? 15 : total <= 120 ? 9 : total <= 300 ? 5 : 3;
    const step = [1, 2, 5, 10, 20, 50, 100, 200, 500].find((s) => s * day >= 28) || 1000;
    return { day, step };
  }
  function filteredRows(rows) {
    return rows.filter(
      (t) =>
        (!criticalOnly || t.critical) &&
        (!search ||
          [t.id, t.name, t.owner]
            .join(" ")
            .toLocaleLowerCase("vi")
            .includes(search.toLocaleLowerCase("vi"))),
    );
  }
  const planningDrafts = new Map();
  let planningWorker = null, planningRun = 0;
  function planningDraft() {
    const p = project(), fingerprint = Planner.fingerprint(p.tasks);
    let d = planningDrafts.get(p.id);
    if (!d || d.fingerprint !== fingerprint) {
      const r = Planner.active(p);
      d = { fingerprint, options: Planner.options(p.planning || {}, p), manual: Object.fromEntries(r.rows.map(t=>[t.id,t.es])), report: null, busy:false, preview:0, error:'' };
      planningDrafts.set(p.id,d);
    }
    return d;
  }
  function readPlanningForm() {
    const d=planningDraft(),form=$('#planner-config');if(!form)return d;
    const f=formValues(form);
    d.options={...d.options,goal:f.get('planGoal')||d.options.goal,strategy:f.get('planStrategy')||d.options.strategy,priority:f.get('planPriority')||d.options.priority,capacity:Number(f.get('planCapacity')),maxDuration:Number(f.get('planDeadline')),indirectPerDay:Number(f.get('planIndirect')),mobilizationRate:Number(f.get('planMobilization')),allowCrash:f.has('planCrash')};
    $$('[data-manual-start]').forEach(input=>{d.manual[input.dataset.manualStart]=Number(input.value);if(input.value==='')d.manual[input.dataset.manualStart]=NaN;});return d;
  }
  function planningChoice(name,value,label,description,selected) {
    return `<label class="plan-choice ${selected?'selected':''}"><input type="radio" name="nen_${name}" value="${value}" ${selected?'checked':''}><span><strong>${label}</strong><small>${description}</small></span></label>`;
  }
  function chosenPlanning(d=planningDraft()) {return d.report?.alternatives[d.preview]||d.report?.best||null;}
  function planningView() {
    const p=project(),d=planningDraft(),o=d.options,active=calc(),selected=p.planning?.selected?.fingerprint===d.fingerprint;
    const manual=o.strategy==='manual',algorithm=o.strategy==='algorithm';
    const config=`<form id="planner-config" data-form="planning"><fieldset class="plan-fieldset"><legend>1. Bạn muốn giải theo hướng nào?</legend><div class="plan-goals">${planningChoice('planGoal','analyze','Giải toàn bộ dự án','Tiến độ, đường găng, nhân công và chi phí. Thuật toán tìm lịch ngắn nhất thỏa năng lực.',o.goal==='analyze')}${planningChoice('planGoal','optimize','Tối ưu nguồn lực & chi phí','Điều hòa biểu đồ nhân lực (K1, K2) hoặc giảm tổng chi phí trong hạn hoàn thành.',o.goal==='optimize')}</div></fieldset><fieldset class="plan-fieldset"><legend>2. Chọn cách xếp sau khi nhập công tác</legend><div class="plan-methods">${planningChoice('planStrategy','manual','01 · Tự xếp tay','Tự nhập ngày bắt đầu; hệ thống kiểm tra quan hệ và năng lực.',manual)}${planningChoice('planStrategy','basic','02 · Xếp cơ bản','Đặt công việc ở thời điểm sớm nhất theo FS / SS / FF / SF.',o.strategy==='basic')}${planningChoice('planStrategy','algorithm','03 · Xếp bằng thuật toán','Bài nhỏ duyệt đầy đủ (chứng minh tối ưu); bài lớn tìm kiếm có cận dưới để so sánh.',algorithm)}</div></fieldset><div class="plan-settings"><div class="form-grid">${field('planCapacity','Năng lực tối đa (người/ngày)',o.capacity,'number','min="0" max="100000" step="1"')}${field('planDeadline','Hoàn thành chậm nhất tại mốc (ngày)',o.maxDuration,'number','min="0" max="100000" step="1"')}${field('planIndirect','Gián tiếp mỗi ngày công trường · '+escape(p.currency),o.indirectPerDay,'number','min="0" max="1000000000000000" step="any"')}${field('planMobilization','Chi phí huy động / người / lần · '+escape(p.currency),o.mobilizationRate,'number','min="0" max="1000000000000000" step="any"')}${o.goal==='optimize'?selectField('planPriority','Mục tiêu tối ưu',o.priority,[['workforce','Điều hòa nhân lực · đỉnh thấp, biểu đồ đều (K1, K2)'],['cost','Tổng chi phí thấp nhất · trực tiếp + gián tiếp + huy động']]):`<div class="field"><label>Mục tiêu của thuật toán</label><p class="plan-objective-note">Lịch <strong>ngắn nhất</strong> không vượt năng lực; hòa thì chọn đỉnh nhân lực thấp hơn.</p><input type="hidden" name="nen_planPriority" value="${escape(o.priority)}"></div>`}<label class="plan-checkbox"><input type="checkbox" name="nen_planCrash" ${o.allowCrash?'checked':''}>Thử rút ngắn công tác trong giới hạn đã nhập</label></div><p class="form-caption">Mốc 0 là đầu ngày khởi công. Chi phí trực tiếp đã gồm nhân công; chỉ cộng gián tiếp/ngày và huy động theo đơn giá bạn nhập. Cài đặt này dùng để so sánh phương án, tách khỏi máy tính lãi vay.</p></div>${manual?`<div class="plan-manual"><div class="panel-head"><div><h3>Tự xếp mốc bắt đầu</h3><p>Nhập số hoặc dùng − / + để dịch từng công tác; kiểm tra trước khi áp dụng.</p></div><button type="button" class="btn ghost small" data-action="manual-earliest">Điền theo CPM</button></div><div class="table-scroll"><table><thead><tr><th>Công tác</th><th>Quan hệ</th><th>Thời lượng</th><th>Bắt đầu tại mốc</th><th>Nhân công</th></tr></thead><tbody>${p.tasks.map(t=>`<tr><td class="task-name"><span class="code">${escape(t.id)}</span>${escape(t.name)}</td><td>${escape(CT.depText(t.deps))||'—'}</td><td>${t.duration} ngày</td><td><div class="manual-stepper"><button type="button" data-manual-shift="${escape(t.id)}" data-delta="-1" aria-label="Dời ${escape(t.id)} sớm 1 ngày">−</button><input type="number" data-manual-start="${escape(t.id)}" value="${Number.isFinite(d.manual[t.id])?d.manual[t.id]:''}" min="0" max="100000" step="1" required aria-label="Mốc bắt đầu ${escape(t.id)}"><button type="button" data-manual-shift="${escape(t.id)}" data-delta="1" aria-label="Dời ${escape(t.id)} muộn 1 ngày">+</button></div></td><td>${t.workers}</td></tr>`).join('')}</tbody></table></div></div>`:''}<div class="plan-submit"><span>${p.tasks.length} công tác · <strong>Cách nào cũng có đường găng và chi phí</strong></span><button type="submit" class="btn primary" ${d.busy?'disabled':''}>${d.busy?'Đang tìm phương án…':manual?'Kiểm tra lịch xếp tay':algorithm?'Tìm phương án tối ưu ↗':'Giải tiến độ cơ bản ↗'}</button>${d.busy?'<button type="button" class="btn ghost" data-action="cancel-planning">Dừng tìm kiếm</button>':''}</div><p id="planner-live" class="form-caption" aria-live="polite">${d.busy?'Thuật toán chạy riêng để bạn vẫn có thể thao tác.':d.error?escape(d.error):''}</p></form>`;
    return `<div class="plan-current"><span>${selected?'Phương án đang áp dụng: '+({manual:'Xếp tay',basic:'CPM cơ bản',algorithm:'Thuật toán'}[p.planning.strategy]):'Đang hiển thị lịch CPM sớm nhất'}</span><strong>${active.duration} ngày · ${active.critical.length} công tác găng</strong>${selected?'<button class="text-link" data-action="clear-planning">Về lịch CPM gốc</button>':''}</div><section class="panel planning-panel"><div class="panel-head"><div><h2>Chọn cách giải & xếp công việc</h2><p>Nhập xong công tác, chọn một cách xếp và xem trước trước khi áp dụng.</p></div><button class="text-link" data-schedule-tab="tasks">Sửa dữ liệu đầu vào</button></div><div class="panel-body">${config}</div></section>${d.report?planningReportView(d):'<div class="callout">Lịch cơ bản có thể vượt năng lực. Lịch thuật toán chỉ nhận phương án thỏa giới hạn. Nếu công nghệ buộc nhân lực tăng giảm nhiều lần, kết quả sẽ ghi rõ mức biến động còn lại.</div>'}`;
  }
  function planningReportView(d) {
    const report = d.report, plan = chosenPlanning(d), o = report.options;
    const objectiveLabel = { time: "Thời gian ngắn nhất trong giới hạn nhân lực", workforce: "Điều hòa nhân lực", cost: "Tổng chi phí thấp nhất" }[report.objective] || "";
    if (!plan) {
      const near = report.nearest;
      const nearNote = near ? `<div class="callout">Lịch ngắn nhất tìm được không vượt năng lực: <strong>${near.metrics.duration} ngày</strong> (trễ ${near.metrics.duration - o.maxDuration} ngày so với hạn ${o.maxDuration}), đỉnh ${num(near.metrics.peak)} người. Có thể đặt hạn từ ${near.metrics.duration} ngày rồi giải lại.</div>` : "";
      const boundNote = report.bounds ? `<p class="form-caption">Cận dưới lý thuyết: thời gian ≥ ${report.bounds.duration} ngày (đường găng hoặc tổng công ÷ năng lực).</p>` : "";
      return `<section class="panel"><div class="panel-body"><h2>Chưa có lịch thỏa đồng thời năng lực và hạn hoàn thành</h2><p>${escape(report.reason || "Kiểm tra dữ liệu đầu vào.")}</p>${nearNote}${boundNote}<p class="form-caption">Có thể tăng hạn hoàn thành, tăng năng lực, cho phép rút ngắn hoặc điều chỉnh nhân công của công tác.${report.method === "infeasible" ? " Một công tác đã cần nhiều người hơn năng lực, không thể sửa chỉ bằng dịch lịch." : ""}</p></div></section>`;
    }
    if (!plan.metrics) return `<div class="callout plan-errors" role="alert">${plan.issues.map((i) => escape(i.message)).join("<br>")}</div>`;
    const tasks = Planner.effective(project().tasks, plan.durations), schedule = Planner.result(tasks, plan, o.capacity);
    const m = plan.metrics, b = report.basic.metrics, c = plan.costs, bc = report.basic.costs;
    const proof = report.method === "exhaustive" ? "Tối ưu đã chứng minh · duyệt đầy đủ miền ngày nguyên" : report.method === "heuristic" ? "Phương án tốt nhất tìm được · chưa chứng minh tối ưu" : o.strategy === "manual" ? "Giữ nguyên mốc bắt đầu bạn nhập" : "Lịch sớm nhất theo quan hệ công việc";
    const allowApply = plan.valid || (o.strategy === "basic" && !plan.issues.some((i) => ["start", "relation"].includes(i.kind)));
    const reached = report.bounds ? [m.peak <= report.bounds.peak + 1e-9 ? "đỉnh đã bằng cận dưới (tối ưu về đỉnh)" : "", m.duration <= report.bounds.duration ? "thời gian đã bằng cận dưới (ngắn nhất có thể)" : ""].filter(Boolean) : [];
    const bounds = report.bounds && o.strategy === "algorithm" ? ` Cận dưới lý thuyết: đỉnh ≥ ${num(report.bounds.peak, 1)} người, thời gian ≥ ${report.bounds.duration} ngày${reached.length ? " — " + reached.join(", ") : ""}.` : "";
    const rows = [
      ["Thời gian", b.duration + " ngày", m.duration + " ngày"],
      ["Đỉnh nhân công Rmax", num(b.peak) + " người", num(m.peak) + " người"],
      ["Nhân lực trung bình Rtb = S / T", num(b.average, 1) + " người", num(m.average, 1) + " người"],
      ["Hệ số không điều hòa K1 = Rmax / Rtb", num(b.k1, 2), num(m.k1, 2)],
      ["Hệ số phân bố K2 = Sdư / S", num(b.k2, 3), num(m.k2, 3)],
      ["Tổng công S", num(b.work) + " công", num(m.work) + " công"],
      ["Số người huy động thêm (cộng dồn)", num(b.mobilizations), num(m.mobilizations)],
      ["Ngày vượt năng lực", b.overDays, m.overDays],
      ["Chi phí trực tiếp", money(bc.direct), money(c.direct)],
      ["Gián tiếp theo ngày", money(bc.indirect), money(c.indirect)],
      ["Huy động nhân công", money(bc.mobilization), money(c.mobilization)],
      ["Tổng chi phí so sánh", money(bc.total), money(c.total)],
    ];
    const alternatives = report.alternatives.length > 1 ? `<div class="plan-alternatives"><strong>Các phương án khác tìm được</strong>${report.alternatives.map((a, i) => `<button data-plan-preview="${i}" class="btn small ${d.preview === i ? "primary" : "ghost"}">${a.metrics.duration} ngày · đỉnh ${num(a.metrics.peak)} · K1 ${num(a.metrics.k1, 2)} · ${shortMoney(a.costs.total)}</button>`).join("")}</div>` : "";
    const issues = plan.issues.length ? `<div class="callout plan-errors" role="alert">${plan.issues.map((i) => escape(i.message)).join("<br>")}${o.strategy === "basic" ? "<br>Lịch cơ bản phản ánh quan hệ; áp dụng lịch này vẫn giữ các cảnh báo vượt nguồn lực." : ""}</div>` : "";
    const table = `<div class="plan-comparison table-scroll"><table><thead><tr><th>Chỉ tiêu</th><th>CPM cơ bản</th><th>Phương án đang xem</th></tr></thead><tbody>${rows.map((x) => `<tr><th>${x[0]}</th><td class="num">${x[1]}</td><td class="num"><strong>${x[2]}</strong></td></tr>`).join("")}</tbody></table></div>`;
    const taskRows = schedule.rows.map((t) => `<tr><td><span class="code">${escape(t.id)}</span>${escape(t.name)}</td><td class="num">${t.es} → ${t.ef}</td><td>${taskDates(project(), t)}</td><td class="num">${t.duration}</td><td class="num">${num(t.workers)}</td><td class="num">${money(t.cost)}</td><td class="num">${t.tf}</td><td class="num">${t.cpmEs} → ${t.cpmEf}</td><td><span class="badge ${t.critical ? "critical" : "neutral"}">${t.critical ? "Găng" : "Có dự trữ"}</span></td></tr>`).join("");
    return `<section class="panel planning-result"><div class="panel-head"><div><p class="eyebrow">KẾT QUẢ XẾP LỊCH · ${escape(proof)}</p><h2>${m.duration} ngày · đỉnh ${num(m.peak)} người · ${money(c.total)}</h2><p>${objectiveLabel && o.strategy === "algorithm" ? "Mục tiêu: " + objectiveLabel + ". " : ""}${report.evaluated > 1 ? fmt(report.evaluated) + " phương án đã đánh giá" : ""}${report.elapsedMs !== undefined ? " · " + (report.elapsedMs < 10 ? "dưới 0,01" : num(report.elapsedMs / 1000, 2)) + " giây." : ""}${bounds}</p></div><div class="panel-tools"><button class="btn ghost small" data-action="planning-csv">Xuất CSV</button><button class="btn ghost small" data-action="planning-report">Xuất báo cáo</button><button class="btn primary small" data-action="apply-planning" ${!allowApply ? "disabled" : ""}>Áp dụng phương án</button></div></div>${issues}${table}<div class="panel-body"><div class="plan-charts"><div><h3>Trước · CPM cơ bản</h3>${resourceChart(report.basic.crew.map((people, day) => ({ people, day })), o.capacity)}</div><div><h3>Sau · phương án đang xem</h3>${resourceChart(plan.crew.map((people, day) => ({ people, day })), o.capacity)}</div></div><p class="form-caption">K1 càng gần 1 và K2 càng gần 0 thì biểu đồ nhân lực càng đều. Sdư là phần công nằm trên đường trung bình Rtb (nét chấm). Tổng công giữ nguyên nếu không rút ngắn; rút ngắn giả định tăng người để giữ ít nhất hao phí ngày công ban đầu (làm tròn lên).</p>${alternatives}<h3>Đường găng của phương án</h3>${criticalLinks(schedule)}${networkView(schedule, true)}<p class="form-caption">CPM thuần cho bộ thời lượng này: ${schedule.cpmDuration} ngày · công tác găng ${schedule.cpmCritical.map(escape).join(", ")}. Lịch bố trí: ${schedule.duration} ngày. Găng của phương án xét cả quan hệ lẫn giới hạn ${num(o.capacity)} người: dời công tác găng sẽ đẩy lùi ngày hoàn thành hoặc vượt năng lực.</p><div class="table-scroll"><table><thead><tr><th>Công tác</th><th>Bắt đầu → kết thúc</th><th>Ngày thực hiện</th><th>Thời lượng</th><th>Người/ngày</th><th>Chi phí trực tiếp</th><th>Dự trữ (xét nhân lực)</th><th>CPM ES → EF</th><th>Găng phương án</th></tr></thead><tbody>${taskRows}</tbody></table></div><div class="data-note">Nguồn lực gộp chung, cố định trong mỗi công tác và không ngắt quãng. Chưa phân nghề, tăng ca, năng suất thực tế hoặc lãi vay trong hàm mục tiêu. Đơn giá 0 được hiểu là chưa tính thành phần đó.</div></div></section>`;
  }
  async function runPlanning() {
    const d=readPlanningForm(),p=copy(project()),id=p.id,token=++planningRun;
    for(const other of planningDrafts.values()) other.busy=false;
    d.stale=false;
    d.options=Planner.options(d.options,p);d.error='';d.preview=0;d.report=null;
    if(d.options.strategy!=='algorithm'){d.report=Planner.solve(p,d.options,d.manual);render();return;}
    planningWorker?.terminate();d.busy=true;render();
    try {
      const report=await new Promise((resolve,reject)=>{
        if(location.protocol==='file:'||!window.Worker){setTimeout(()=>{try{resolve(Planner.solve(p,d.options,d.manual,{maxMs:2500}));}catch(e){reject(e);}},60);return;}
        const worker=planningWorker=new Worker('planner-worker.js');worker.onmessage=e=>{worker.terminate();if(e.data.error)reject(Error(e.data.error));else resolve(e.data.result);};worker.onerror=e=>{worker.terminate();reject(Error('Không chạy được bộ xếp lịch: '+e.message));};worker.postMessage({project:p,options:d.options,manual:d.manual});
      });
      if(token!==planningRun)return;d.report=report;d.busy=false;
      if(project().id===id&&page==='schedule'&&scheduleTab==='planner')render();
      toast(report.best?'Đã tìm phương án; xem đường găng và chi phí trước khi áp dụng.':report.reason,!report.best);
    } catch(error){d.busy=false;d.error=error.message;if(project().id===id&&page==='schedule')render();}
  }
  async function applyPlanning() {
    const d=readPlanningForm(),plan=chosenPlanning(d);if(!plan)return;
    if(d.stale)throw Error("Cấu hình đã đổi. Hãy giải lại trước khi áp dụng.");
    if(d.fingerprint!==Planner.fingerprint(project().tasks))throw Error('Dữ liệu đã đổi; hãy xếp lại.');
    const o=d.report.options;
    if(!plan.valid&&o.strategy!=='basic')throw Error('Sửa các vi phạm trước khi áp dụng lịch.');
    await commit(p=>{p.capacity=o.capacity;p.planning={...o,selected:{fingerprint:Planner.fingerprint(p.tasks),starts:plan.starts,durations:plan.durations}};},'Đã áp dụng '+({manual:'lịch xếp tay',basic:'lịch CPM cơ bản',algorithm:'phương án thuật toán'}[o.strategy]));
  }
  function exportPlanning(html=false) {
    const d=planningDraft(),plan=chosenPlanning(d);if(!plan)return;const p=project(),r=Planner.result(Planner.effective(p.tasks,plan.durations),plan,d.report.options.capacity);
    if(!html){exportCSV('phuong-an-tien-do-chi-phi.csv',['Mã','Công tác','Bắt đầu bố trí','Kết thúc bố trí','Thời lượng','Người/ngày','Chi phí trực tiếp '+p.currency,'Găng phương án','CPM ES','CPM EF','CPM LS','CPM LF','CPM TF','Găng CPM'],r.rows.map(t=>[t.id,t.name,t.es,t.ef,t.duration,t.workers,t.cost,t.critical?'Có':'Không',t.cpmEs,t.cpmEf,t.cpmLs,t.cpmLf,t.cpmTf,t.cpmCritical?'Có':'Không']));return;}
    const body=planningReportView(d),css='body{font:14px/1.6 Arial,sans-serif;color:#17365e;margin:35px;max-width:1200px}h1,h2,h3{color:#032b91}table{width:100%;border-collapse:collapse;margin:18px 0}th,td{border:1px solid #c7d8eb;padding:8px;text-align:left}.num{text-align:right}.panel-tools,.plan-alternatives{display:none}.plan-charts{display:flex;gap:20px}.plan-charts>div{width:50%}svg{width:100%}.form-caption,.data-note{font-size:12px}.path-node{display:inline-block;padding:6px;background:#edf4ff;margin:3px}.critical{color:#b34b32}.table-scroll{overflow:visible}@media print{body{margin:10mm;font-size:10pt}.plan-charts{break-inside:avoid}thead{display:table-header-group}}';
    download('bao-cao-phuong-an-xay-dung.html',`<!doctype html><html lang="vi"><meta charset="utf-8"><title>Báo cáo · ${escape(p.name)}</title><style>${css}</style><h1>${escape(p.name)}</h1><p>Ngày lập ${new Date().toLocaleString('vi-VN',{timeZone:'Asia/Bangkok'})} · Đơn vị ${escape(p.currency)} · Chế độ ${escape(d.report.options.strategy)}</p>${body}</html>`,'text/html;charset=utf-8');
  }

  function scheduleView() {
    const p = project(),
      r = calc();
    const rows = filteredRows(r.rows);
    if (scheduleTab === "planner") return heading("Giải & tối ưu kế hoạch", "Nhập công tác → chọn cách xếp → xem đường găng, nhân công và chi phí.", `<button class="btn ghost" data-schedule-tab="gantt">Xem Gantt</button>${primaryAdd()}`) + planningView();
    return (
      heading(
        "Tiến độ & đường găng",
        "Nhập quan hệ, xem điều gì quyết định ngày hoàn thành dự án.",
        `<button class="btn ghost" data-action="baseline">◎ Chốt kế hoạch gốc</button><button class="btn ghost" data-action="csv">↓ CSV</button>${primaryAdd()}`,
      ) +
      `<div class="kpi-grid">${kpi("Thời gian dự án", r.duration, "Kết thúc ngày làm việc cuối: " + finishDate(p, r), "accent", "ngày")}${kpi("Công việc găng", r.critical.length, "Dự trữ toàn phần TF = 0", "danger")}${kpi("Quan hệ trước–sau", r.edges.length, "Hỗ trợ FS · SS · FF · SF")}${kpi("So với kế hoạch gốc", p.baseline ? (r.duration - p.baseline.duration > 0 ? "+" : "") + (r.duration - p.baseline.duration) : "—", p.baseline ? "Chênh lệch thời lượng dự án" : "Chốt kế hoạch gốc để so sánh", "", "ngày")}</div>` +
      `<section class="panel"><div class="panel-head"><div><h2>Kế hoạch công việc</h2><p>Bấm công việc để sửa thời lượng, quan hệ, nguồn lực và chi phí.</p></div><div class="panel-tools"><input id="task-search" type="search" placeholder="Tìm mã, tên, phụ trách…" value="${escape(search)}" aria-label="Tìm công việc"><label class="filter-check"><input id="critical-filter" type="checkbox" ${criticalOnly ? "checked" : ""}>Chỉ công việc găng</label></div></div><div class="tabbar" role="tablist" aria-label="Chế độ xem tiến độ">${[
        ["gantt", "Biểu đồ Gantt"],
        ["tasks", "Dữ liệu đầu vào"],
        ["cpm", "Thông số CPM"],
        ["planner", "Xếp & tối ưu"],
      ]
        .map(
          ([k, v]) =>
            `<button data-schedule-tab="${k}" role="tab" aria-selected="${scheduleTab === k}" class="${scheduleTab === k ? "active" : ""}">${v}</button>`,
        )
        .join(
          "",
        )}<span style="margin-left:auto" class="currency-label">${escape(p.currency)}</span></div><div id="schedule-content">${!p.tasks.length ? empty("Chưa có công việc", "Bạn có thể tạo công việc mới hoặc mở một bộ dữ liệu mẫu.", "add-task", "+ Thêm công việc") : scheduleTab === "gantt" ? `<div class="table-scroll">${gantt(r)}</div>` : scheduleTab === "cpm" ? `<div class="table-scroll"><table><thead><tr><th>Mã</th><th>Công việc</th><th>ES</th><th>EF</th><th>LS</th><th>LF</th><th>TF</th><th>Dự trữ riêng</th><th>Trạng thái</th><th>Ngày thực hiện</th>${r.placement ? "<th>CPM thuần ES → EF · TF</th>" : ""}</tr></thead><tbody>${rows.map((t) => `<tr class="click-row" data-edit-task="${escape(t.id)}"><td>${escape(t.id)}</td><td class="task-name">${escape(t.name)}</td>${["es", "ef", "ls", "lf", "tf", "ff"].map((k) => `<td class="num">${t[k]}</td>`).join("")}<td><span class="badge ${t.critical ? "critical" : "neutral"}">${t.critical ? "Găng" : "Có dự trữ"}</span></td><td>${taskDates(p, t)}</td>${r.placement ? `<td class="num">${t.cpmEs} → ${t.cpmEf} · ${t.cpmTf}</td>` : ""}</tr>`).join("")}</tbody></table></div>${r.placement ? `<p class="form-caption" style="padding:12px 20px">Đang áp dụng phương án xếp lịch: ES/EF là mốc đã bố trí; LS/LF/TF tính lùi có xét giới hạn ${num(p.planning?.capacity ?? p.capacity)} người. Cột cuối là CPM thuần (không xét nhân lực) để đối chiếu.</p>` : ""}` : `<div class="table-scroll"><table><thead><tr><th>Công việc</th><th>Thời lượng</th><th>Quan hệ trước</th><th>Phụ trách</th><th>Hoàn thành</th><th>Ngân sách</th><th>Nhân công</th></tr></thead><tbody>${rows.map((t) => `<tr class="click-row" data-edit-task="${escape(t.id)}"><td class="task-name"><span class="code">${escape(t.id)}</span>${escape(t.name)}</td><td class="num">${t.duration} ngày</td><td class="task-deps">${escape(CT.depText(t.deps)) || "—"}</td><td>${escape(t.owner) || "Chưa giao"}</td><td><span class="tiny-progress"><i><b style="width:${t.progress}%"></b></i>${fmt(t.progress)}%</span></td><td class="num">${money(t.cost)}</td><td class="num">${t.workers}</td></tr>`).join("")}</tbody></table></div>`}</div><div class="data-note">${legend()}<p style="margin-top:10px">Mốc 0 là đầu ngày khởi công. EF là ranh giới kết thúc, không phải số thứ tự ngày cuối. Lịch ${p.workdays.length} ngày/tuần${p.holidays?.length ? ", trừ " + p.holidays.length + " ngày lễ" : ", chưa nhập ngày lễ"}. Nét xanh dọc: ngày báo cáo.${p.baseline ? " Nét mảnh dưới thanh: kế hoạch gốc." : ""}</p></div></section>` +
      panel(
        "Liên kết găng",
        "Các quan hệ chặt của lịch đang áp dụng; CPM thuần được giữ trong tab Thông số CPM",
        `<div class="panel-body">${criticalLinks(r)}<p class="form-caption">Có thể có nhiều nhánh găng đồng thời. Với SS/FF/SF, thời gian dự án không bằng tổng thời lượng các nút trên nhánh.</p></div>`,
      ) +
      `<div class="heading-actions"><button class="btn ghost small" data-action="sample-textbook">Mở bài mẫu A–G</button><button class="btn ghost small" data-action="import">↑ Nhập JSON</button><button class="btn ghost small" data-page="guide">Giải thích FS / SS / FF / SF</button></div>`
    );
  }
  function criticalLinks(r) {
    const e = r.edges.filter((x) => x.critical);
    return `<div class="path-line">${e.length ? e.map((x) => `<span class="path-node">${escape(x.from)} <span class="path-rel">${x.type}${x.lag >= 0 ? "+" : ""}${x.lag} →</span> ${escape(x.to)}</span>`).join("") : r.critical.map((id) => `<span class="path-node">${escape(id)}</span>`).join("") || '<span class="muted">Chưa có công việc.</span>'}</div>`;
  }
  const graphDrafts=new Map();let graphNodeStyle='circle';
  function graphDraftFor(r,kind){const key=project().id+':'+kind+(kind==='aon'?':'+graphNodeStyle:''),graph=GraphBoard.build(r,kind,{style:graphNodeStyle});let draft=graphDrafts.get(key);if(!draft){let local=null;try{local=JSON.parse(localStorage.getItem('nen.graph.'+key));}catch{}const saved=project().networkLayouts?.[kind];draft={positions:GraphBoard.positions(graph,(team?saved||local:local||saved)||{}),zoom:1,dirty:false};graphDrafts.set(key,draft);}draft.positions=GraphBoard.positions(graph,draft.positions);draft.graph=graph;return draft;}
  function graphMarkup(r,kind='aon',interactive=false){const draft=graphDraftFor(r,kind);return GraphBoard.svg(draft.graph,draft.positions,graphNodeStyle,interactive);}
  function graphTools(){return `<div class="graph-tools"><label>Kiểu nút <select id="graph-node-style"><option value="circle" ${graphNodeStyle==='circle'?'selected':''}>Tròn · theo bài giảng</option><option value="card" ${graphNodeStyle==='card'?'selected':''}>Thẻ thông số</option></select></label><button class="btn ghost small" data-action="graph-auto">Xếp tự động</button><button class="btn ghost small" data-action="graph-fit">Vừa khung</button><button class="btn ghost small" data-graph-zoom="0.85" aria-label="Thu nhỏ sơ đồ">−</button><button class="btn ghost small" data-graph-zoom="1.18" aria-label="Phóng to sơ đồ">+</button><button class="btn primary small" data-action="graph-save" ${team&&!["owner","editor"].includes(project()._role)?'disabled':''}>Lưu bố trí</button><span id="graph-save-state" class="form-caption">Kéo nút để sắp xếp; nháy đúp công việc để sửa.</span></div>`;}
  function activeGraphDraft(){return graphDraftFor(calc(),networkType==='aoa'?'aoa':'aon');}
  function mountGraphEditor(){const svg=$('#network-svg [data-draggable-graph]');if(!svg)return;const draft=activeGraphDraft(),kind=draft.graph.kind;if(svg.dataset.editorMounted){const b=GraphBoard.bounds(draft.graph,draft.positions);svg.style.width=b.width*draft.zoom+'px';svg.style.height=b.height*draft.zoom+'px';return;}svg.dataset.editorMounted='true';let drag=null;
    const point=event=>{const p=svg.createSVGPoint();p.x=event.clientX;p.y=event.clientY;return p.matrixTransform(svg.getScreenCTM().inverse());};
    const paint=()=>{const b=GraphBoard.bounds(draft.graph,draft.positions);svg.setAttribute('width',b.width);svg.setAttribute('height',b.height);svg.setAttribute('viewBox',`0 0 ${b.width} ${b.height}`);svg.style.width=b.width*draft.zoom+'px';svg.style.height=b.height*draft.zoom+'px';const clean=DOMPurify.sanitize('<svg xmlns="http://www.w3.org/2000/svg">'+GraphBoard.contents(draft.graph,draft.positions,graphNodeStyle)+'</svg>',{USE_PROFILES:{svg:true,svgFilters:true}});const parsed=new DOMParser().parseFromString(clean,'image/svg+xml');svg.replaceChildren(...document.importNode(parsed.documentElement,true).childNodes);};
    paint();
    svg.addEventListener('pointerdown',event=>{const node=event.target.closest('[data-node-key]');if(!node||event.button>0)return;const key=node.dataset.nodeKey,p=point(event);drag={key,start:p,origin:{...draft.positions[key]},moved:false};svg.setPointerCapture(event.pointerId);event.preventDefault();});
    svg.addEventListener('pointermove',event=>{if(!drag)return;const p=point(event),dx=p.x-drag.start.x,dy=p.y-drag.start.y;if(Math.abs(dx)+Math.abs(dy)>3)drag.moved=true;draft.positions[drag.key]={x:Math.max(100,Math.min(20000,drag.origin.x+dx)),y:Math.max(85,Math.min(20000,drag.origin.y+dy))};paint();});
    const finish=()=>{if(!drag)return;if(drag.moved){draft.dirty=true;try{localStorage.setItem('nen.graph.'+project().id+':'+kind,JSON.stringify(draft.positions));}catch{}if($('#graph-save-state'))$('#graph-save-state').textContent='Đã giữ bố trí trên máy này · bấm Lưu bố trí để lưu vào dự án.';}drag=null;};
    svg.addEventListener('pointerup',finish);svg.addEventListener('pointercancel',finish);
    svg.addEventListener('dblclick',event=>{const key=event.target.closest('[data-node-key]')?.dataset.nodeKey;if(key&&project().tasks.some(t=>t.id===key)){event.stopPropagation();taskModal(key);}});
    svg.addEventListener('keydown',event=>{const key=event.target.closest('[data-node-key]')?.dataset.nodeKey;if(!key)return;if(event.key==='Enter'){event.preventDefault();event.stopPropagation();if(project().tasks.some(t=>t.id===key))taskModal(key);return;}const delta={ArrowLeft:[-1,0],ArrowRight:[1,0],ArrowUp:[0,-1],ArrowDown:[0,1]}[event.key];if(!delta)return;event.preventDefault();event.stopPropagation();const scale=event.shiftKey?50:10,p=draft.positions[key];p.x=Math.max(100,Math.min(20000,p.x+delta[0]*scale));p.y=Math.max(85,Math.min(20000,p.y+delta[1]*scale));draft.dirty=true;paint();svg.querySelector('[data-node-key="'+CSS.escape(key)+'"]')?.focus();});
  }

  let networkType='aon',pertTarget=NaN;
  function networkChoices(){return `<div class="network-choices"><label for="network-type">Cách thể hiện</label><select id="network-type"><option value="aon" ${networkType==='aon'?'selected':''}>AON / PDM · công việc trên nút</option><option value="aoa" ${networkType==='aoa'?'selected':''}>AOA · công việc trên mũi tên</option><option value="gantt" ${networkType==='gantt'?'selected':''}>Gantt · tiến độ ngang</option><option value="linked" ${networkType==='linked'?'selected':''}>Gantt liên kết</option><option value="linear" ${networkType==='linear'?'selected':''}>Tiến độ xiên / dây chuyền</option><option value="pert" ${networkType==='pert'?'selected':''}>PERT · thời gian ba ước lượng</option></select><small>Tham khảo CI5407 C5 và CI5405 C3–C4.</small></div>`;}
  function graphResult(title,description,body){return heading(title,description,`<button class="btn ghost" data-action="network-svg">Tải SVG</button>`)+networkChoices()+panel(title,description,`<div class="network-wrap" id="network-svg">${body}</div>`);}
  function aoaView(r){try{const markup=graphMarkup(r,'aoa',true);return heading('Sơ đồ AOA','Công việc trên mũi tên; nút là sự kiện, có thời điểm sớm và muộn.',`<button class="btn ghost" data-action="network-svg">Tải SVG</button>`)+networkChoices()+graphTools()+panel('Mạng AOA','Nét đứt: công việc giả (0 ngày). Mũi tên «Chờ n»: thời gian chờ của quan hệ FS có lag. Sự kiện đánh số 1…n, đuôi luôn nhỏ hơn đầu.',`<div class="network-wrap" id="network-svg">${markup}</div>`)+`<div class="callout">AOA cổ điển dùng quan hệ FS với lag không âm. Các mốc bố trí nguồn lực được thể hiện riêng trên Gantt; kéo nút chỉ thay bố cục.</div>`;}catch(error){return heading('Sơ đồ AOA','Chọn cách thể hiện phù hợp với dữ liệu.')+networkChoices()+`<div class="callout">${escape(error.message)}<br><button class="text-link" data-action="show-aon">Xem AON / PDM</button></div>`;}}
  function linkedGantt(r){const width=1150,label=270,span=820,den=Math.max(1,r.duration),rowHeight=43,height=65+r.rows.length*rowHeight,positions=new Map(r.rows.map((t,i)=>[t.id,{t,y:65+i*rowHeight}]));const x=v=>label+v/den*span;return `<svg width="${width}" height="${height}" viewBox="0 0 ${width} ${height}" role="img" aria-label="Gantt liên kết"><defs><marker id="linked-arrow" markerWidth="7" markerHeight="7" refX="6" refY="3" orient="auto"><path d="M0 0L6 3L0 6z" fill="#5a7fa7"/></marker></defs>${Array.from({length:11},(_,i)=>`<path d="M${x(r.duration*i/10)} 35V${height}" stroke="#dfebf7"/><text x="${x(r.duration*i/10)}" y="22" font-size="11" text-anchor="middle" fill="#466b95">${fmt(r.duration*i/10,1)}</text>`).join('')}${r.edges.map(e=>{const a=positions.get(e.from),b=positions.get(e.to),sx=x(e.type==='FS'||e.type==='FF'?a.t.ef:a.t.es),tx=x(e.type==='FF'||e.type==='SF'?b.t.ef:b.t.es);return `<path d="M${sx} ${a.y}C${sx+22} ${a.y},${tx-22} ${b.y},${tx} ${b.y}" stroke="${e.critical?'#b45e3b':'#849fba'}" fill="none" stroke-width="1.3" marker-end="url(#linked-arrow)"/>`;}).join('')}${r.rows.map((t,i)=>`<text x="10" y="${positions.get(t.id).y+4}" font-size="12" fill="#204a7c">${escape(t.id+' · '+t.name.slice(0,27))}</text><rect x="${x(t.es)}" y="${positions.get(t.id).y-10}" width="${Math.max(3,t.duration/den*span)}" height="20" rx="3" fill="${t.critical?'#bf6b49':'#2a80cb'}"/><text x="${x(t.es)+5}" y="${positions.get(t.id).y+4}" font-size="10" fill="#fff">${t.duration}n</text>`).join('')}</svg>`;}
  function linearView(r){try{const data=Networks.linear(r.rows,r);if(!data.rows.length)return heading('Tiến độ xiên / dây chuyền','Trục ngang là thời gian; trục đứng là phân đoạn.')+networkChoices()+`<div class="callout">Chưa có dữ liệu phân đoạn. Trong biểu mẫu công việc, mở “Sơ đồ xiên”, nhập số phân đoạn và tên nhóm quá trình. Các công tác cùng quá trình ở các phân đoạn sẽ được nối thành dải tiến độ.<br><button class="text-link" data-page="schedule">Nhập phân đoạn cho công việc</button></div>`;const warn=data.warnings?.length?`<div class="callout warning"><strong>Cần kiểm tra dây chuyền</strong><br>${data.warnings.map(escape).join('<br>')}</div>`:'';return graphResult('Tiến độ xiên / dây chuyền','Mỗi công tác là một đường xiên qua dải phân đoạn của nó; thời điểm lấy từ lịch đang áp dụng.',GraphBoard.cyclogram(data))+warn;}catch(error){return heading('Tiến độ xiên','Kiểm tra phân đoạn và nhóm quá trình.')+networkChoices()+`<div class="callout">${escape(error.message)}</div>`;}}

  function networkView(input = null, preview = false) {
    let r = input || calc();
    if(!preview){
      if(networkType==='aoa')return aoaView(r);
      if(networkType==='linked')return graphResult('Gantt liên kết','Thanh là thời lượng; đường nối là quan hệ công việc.',linkedGantt(r));
      if(networkType==='linear')return linearView(r);
      if(networkType==='gantt')return heading('Gantt · tiến độ ngang','Lịch đang áp dụng')+networkChoices()+panel('Biểu đồ Gantt','Công việc găng được tô màu',gantt(r));
      if(networkType==='pert'){const estimate=Networks.pert(project().tasks),info=estimate.project||Networks.pertProbability(estimate);const target=Number.isFinite(pertTarget)?pertTarget:Math.ceil(info.te+info.sigma),chance=Networks.pertProbability(estimate,target);const summary=`<section class="panel pert-summary"><div class="panel-body"><div class="pert-grid"><div><p class="muted">Thời gian kỳ vọng Te</p><div class="info-number">${num(info.te,2)} <span>ngày</span></div></div><div><p class="muted">Độ lệch chuẩn σ = √Σσ²</p><div class="info-number">${num(info.sigma,2)} <span>ngày</span></div></div><div><label for="pert-target" class="muted">Hạn cần đạt T (ngày)</label><input id="pert-target" type="number" min="0" step="1" value="${target}"></div><div><p class="muted">P(hoàn thành ≤ T)</p><div class="info-number">${chance.probability===null?'—':num(chance.probability*100,1)+'<span>%</span>'}</div><small>${chance.z===null?'σ = 0: kết quả xác định':'Z = (T − Te) / σ = '+num(chance.z,2)}</small></div></div><p class="form-caption">Đường găng kỳ vọng: ${info.path.map(escape).join(' → ')}. Hoàn thành với xác suất 90% sau ${num(info.p90,1)} ngày, 95% sau ${num(info.p95,1)} ngày.${estimate.deterministic?' Các công tác hiện có a = m = b nên σ = 0; nhập ba ước lượng trong biểu mẫu công việc để dùng PERT.':''}</p>${info.warnings?.length?`<div class="callout warning">${info.warnings.map(escape).join('<br>')}</div>`:''}</div></section>`;return heading('PERT · thời gian ba ước lượng','te = (a + 4m + b) / 6; σ² = ((b − a) / 6)²; P(T) = Φ((T − Te) / σ) theo đường găng kỳ vọng.')+networkChoices()+summary+panel('Mạng PERT theo kỳ vọng','Dùng nút và quan hệ trước–sau',networkView(estimate,true))+panel('Ước lượng từng công việc','Số liệu gốc vẫn được giữ nguyên',`<div class="table-scroll"><table><thead><tr><th>Mã</th><th>a</th><th>m</th><th>b</th><th>te</th><th>Phương sai</th></tr></thead><tbody>${estimate.rows.map(t=>{const p=t.pert||{a:t.duration,m:t.duration,b:t.duration};return `<tr><td>${escape(t.id)}</td><td>${p.a}</td><td>${p.m}</td><td>${p.b}</td><td>${fmt(t.duration,2)}</td><td>${fmt(estimate.variance[t.id],3)}</td></tr>`;}).join('')}</tbody></table></div>`);}
    }
    if (!r.rows.length)
      return (
        heading(
          "Sơ đồ mạng AON",
          "Quan hệ công việc được tính trực tiếp từ dữ liệu đầu vào.",
          primaryAdd(),
        ) +
        empty(
          "Chưa có mạng công việc",
          "Thêm công việc để xem liên kết trên sơ đồ.",
          "add-task",
          "+ Thêm công việc",
        )
      );
    if(preview)return `<div class="network-wrap graph-preview">${graphMarkup(r,'aon',false)}</div>`;
    return heading('Sơ đồ mạng công việc','AON / PDM · mỗi nút là một công việc; mũi tên là quan hệ trước–sau.',`<button class="btn ghost" data-action="network-svg">Tải SVG</button>`)+networkChoices()+graphTools()+panel('Mạng công việc','Có thể kéo, đổi vị trí và lưu bố cục; số liệu được tính từ công việc.',`<div class="network-wrap" id="network-svg">${graphMarkup(r,'aon',true)}</div><div class="data-note">ES/EF: khởi/kết sớm · LS/LF: khởi/kết muộn · TF: dự trữ toàn phần · FF: dự trữ riêng · D: thời lượng · NC: người/ngày.</div>`)+panel('Các liên kết găng',r.duration+' ngày làm việc',`<div class="panel-body">${criticalLinks(r)}</div>`);
  }
  function constructionControls(scope,index=-1){
    let group='';const options=ConstructionSequence.steps.map((step,i)=>{let html='';if(group!==step.group){if(group)html+='</optgroup>';group=step.group;html+='<optgroup label="'+escape(group)+'">';}return html+`<option value="${i}" ${index===i?'selected':''}>${i+1}. ${escape(step.name)}</option>`;}).join('')+'</optgroup>';
    return `<div class="construction-process" data-process-scope="${scope}"><div><span class="process-counter">${index<0?'THEO NGÀY KẾ HOẠCH':'BƯỚC '+(index+1)+' / '+ConstructionSequence.steps.length}</span><div class="process-navigation"><button type="button" data-process-shift="-1" data-process-target="${scope}" aria-label="Bước trước">← Trước</button><button type="button" data-process-shift="1" data-process-target="${scope}" aria-label="Bước tiếp theo">Tiếp →</button></div></div><select data-process-select="${scope}" aria-label="Chọn bước thi công theo thứ tự">${scope==='project'?'<option value="plan" '+(index<0?'selected':'')+'>Theo ngày trong kế hoạch dự án</option>':''}${options}</select></div>`;
  }
  function updateHeroProcess(){const index=ConstructionSequence.nearest(heroProgress),step=ConstructionSequence.steps[index],wrap=$('[data-process-scope="hero"]');if(wrap){wrap.querySelector('select').value=index;wrap.querySelector('.process-counter').textContent='BƯỚC '+(index+1)+' / '+ConstructionSequence.steps.length;}$('#hero-stage').textContent=step.name;}
  function seekHeroStep(index){index=Math.max(0,Math.min(ConstructionSequence.steps.length-1,index));const step=ConstructionSequence.steps[index];heroProgress=step.p;heroScene.focusFloor=Number(step.group.match(/^Tầng (\d+)$/)?.[1])||null;heroScene.setShot?.(heroProgress);$('#hero-slider').value=heroProgress*100;heroScene.detailMode='auto';heroScene.dirty=true;updateHeroProcess();}
  function modelView() {
    const r = calc();
    sceneDay = Math.min(sceneDay || project().statusDay, r.duration);
    return (
      heading(
        "Thi công 3D",
        "Mô phỏng trình tự thi công gắn với kế hoạch CPM của dự án.",
        `<button class="btn ghost" data-page="schedule">Chỉnh kế hoạch ↗</button>`,
      ) +
      `<section class="panel scene-panel"><div class="panel-head"><div><h2 id="scene-stage-label">Mô phỏng tiến độ kế hoạch</h2><p>Đào đất → lót, thép và bê tông móng → lấp, đầm từng lớp → kết cấu → hoàn thiện</p></div><span class="badge" id="scene-date"></span></div>${constructionControls("project")}<div class="scene-details"><span>CHI TIẾT THI CÔNG</span><button data-detail-mode="foundation">Đi thép móng</button><button data-detail-mode="starters">Thép chờ</button><button data-detail-mode="frame">Cột · dầm · sàn</button><button data-detail-mode="joint">Mạch ngừng</button><button data-detail-mode="auto" aria-pressed="true">Về tiến độ</button></div><div class="scene-canvas-wrap"><div id="machine-status" class="machine-status"></div><img class="scene-poster" src="assets/scene-preview.webp" alt="" aria-hidden="true"><canvas id="project-canvas" aria-label="Mô hình công trình minh họa theo ngày tiến độ"></canvas></div><div class="scene-controls"><button class="btn small" data-action="play-scene" id="play-scene">▶ Chạy</button><button class="btn small motion-pause" data-action="pause-motion" aria-pressed="false">Dừng chuyển động</button><input id="scene-slider" type="range" min="0" max="${Math.max(1, r.duration)}" value="${sceneDay}" aria-label="Ngày làm việc của mô phỏng"><span class="scene-day" id="scene-day-label"></span></div><div id="detail-note" class="detail-note" hidden></div></section><div id="phase-summary" class="phase-grid"></div><div class="callout" style="margin-top:20px">Khối công trình cơ sở 2 minh họa 12 tầng; các công việc được gắn vào giai đoạn trong biểu mẫu. Mô phỏng dựa trên ES/EF, thể hiện <strong>kế hoạch</strong>, chưa phải mô hình BIM từ bản vẽ hay khối lượng nghiệm thu thực tế. Nguyên tắc trình tự tham khảo CI5405, chương 2 trang 25 và chương 3.</div>`
    );
  }
  // ---- Ánh xạ lịch dự án → bước thi công minh họa (ConstructionSequence) ----
  const foldVN = (s) =>
    String(s).normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/đ/gi, "d").toLowerCase().replace(/van khuon/g, "cop pha");
  const STOP_WORDS = new Set(["va", "cac", "cua", "theo", "tu", "tung", "quanh", "cong", "tac", "thi", "phan", "voi", "o"]);
  const wordsOf = (s) => new Set(foldVN(s).split(/[^a-z0-9]+/).filter((w) => w && !STOP_WORDS.has(w)));
  /** Mức giống nhau công việc ↔ bước: "tầng a–b" khớp theo tầng, còn lại theo từ chung (Jaccard). */
  function stepSimilarity(task, step) {
    const name = foldVN(task.name), floor = Number(step.group.match(/^Tầng (\d+)$/)?.[1]);
    const range = name.match(/tang\s*(\d+)\s*(?:[-–—]|den)\s*(\d+)/) || name.match(/tang\s*(\d+)/);
    if (range && floor) return floor >= Number(range[1]) && floor <= Number(range[2] ?? range[1]) ? 1 : 0;
    const a = wordsOf(task.name), b = wordsOf(step.name);
    let common = 0;
    for (const w of a) if (b.has(w)) common++;
    return common ? common / (a.size + b.size - common) : 0;
  }
  const sceneSpanCache = new WeakMap();
  /**
   * Mỗi công việc có giai đoạn được gán một đoạn [start, end) trên thang tiến trình của mô hình.
   * Trong một giai đoạn, công việc (theo ES) được canh hàng có thứ tự với các bước bằng quy hoạch động
   * để tổng mức giống lớn nhất; end dừng sau bước cuối còn khớp tốt (vd. đổ bê tông → bảo dưỡng).
   */
  function sceneSpans(r) {
    if (sceneSpanCache.has(r)) return sceneSpanCache.get(r);
    const steps = ConstructionSequence.steps, bounds = BuildScene.phaseBounds, spans = new Map();
    PHASES.forEach((_, phase) => {
      const lo = bounds[phase], hi = bounds[phase + 1];
      const ids = steps.map((s, i) => i).filter((i) => steps[i].p >= lo && (steps[i].p < hi || (hi === 1 && steps[i].p <= 1)));
      const tasks = r.rows.filter((t) => phaseFor(t) === phase).sort((a, b) => a.es - b.es || a.ef - b.ef);
      if (!tasks.length) return;
      const after = (index) => steps[index + 1]?.p ?? 1;
      if (!ids.length || tasks.length > ids.length) {
        // Ít bước hơn công việc: chia đều thang của giai đoạn theo thứ tự.
        tasks.forEach((t, k) => spans.set(t.id, { start: lo + ((hi - lo) * k) / tasks.length, end: lo + ((hi - lo) * (k + 1)) / tasks.length, matched: ids.some((i) => stepSimilarity(t, steps[i]) > 0) }));
        return;
      }
      const n = tasks.length, m = ids.length, sim = tasks.map((t) => ids.map((i) => stepSimilarity(t, steps[i])));
      const totalDuration = tasks.reduce((s, t) => s + Math.max(1, t.duration), 0);
      // best[j][k]: điểm tốt nhất khi j công việc đầu phủ k bước đầu; choice lưu điểm cắt.
      const best = Array.from({ length: n + 1 }, () => new Array(m + 1).fill(-Infinity)), cut = best.map((row) => row.map(() => 0));
      best[0][0] = 0;
      for (let j = 1; j <= n; j++)
        for (let k = j; k <= m - (n - j); k++)
          for (let i = j - 1; i < k; i++) {
            if (best[j - 1][i] === -Infinity) continue;
            let top = 0;
            for (let x = i; x < k; x++) top = Math.max(top, sim[j - 1][x]);
            // Hòa điểm: ưu tiên chia số bước gần với tỷ lệ thời lượng.
            const share = Math.abs((k - i) / m - Math.max(1, tasks[j - 1].duration) / totalDuration);
            const score = best[j - 1][i] + top - 0.01 * share;
            if (score > best[j][k]) {
              best[j][k] = score;
              cut[j][k] = i;
            }
          }
      for (let j = n, k = m; j > 0; j--) {
        const i = cut[j][k], block = sim[j - 1].slice(i, k), top = Math.max(...block);
        let last = k - 1;
        if (top > 0) while (last > i && block[last - i] < 0.6 * top) last--;
        spans.set(tasks[j - 1].id, { start: steps[ids[i]].p, end: after(ids[last]), matched: top > 0 });
        k = i;
      }
    });
    sceneSpanCache.set(r, spans);
    return spans;
  }
  /** Tiến trình mô hình đầu ngày `day`: việc đã xong đẩy tiến trình lên, việc đang làm chậm nhất quyết định. */
  function sceneProgress(r, day) {
    const spans = sceneSpans(r);
    let done = 0;
    const active = [];
    for (const t of r.rows) {
      const span = spans.get(t.id);
      if (!span) continue;
      if (t.duration ? day >= t.ef : day >= t.es) done = Math.max(done, span.end);
      else if (day >= t.es) active.push({ span, p: span.start + (span.end - span.start) * ((day - t.es) / t.duration) });
    }
    // Việc không khớp bước nào (vd. trực bảo vệ) chỉ dùng khi không còn việc thi công khác.
    const live = active.filter((a) => a.span.end > done), physical = live.filter((a) => a.span.matched);
    const current = (physical.length ? physical : live).map((a) => a.p);
    const raw = current.length ? Math.max(done, Math.min(...current)) : done;
    // Hiện bước đã bắt đầu (không làm tròn lên bước sau, vd. cốp pha chưa xong thì chưa đổ bê tông).
    const steps = ConstructionSequence.steps;
    let index = 0;
    while (index + 1 < steps.length && steps[index + 1].p <= raw + 1e-9) index++;
    return raw < steps[0].p ? raw : steps[index].p;
  }
  function modelProgress(r, day) {
    const hasStages = r.rows.some((t) => phaseFor(t) >= 0);
    const phases = PHASES.map((name, i) => {
      const rows = r.rows.filter((t) => phaseFor(t) === i);
      return {
        name,
        rows,
        value: rows.length
          ? rows.reduce((s, t) => s + (t.duration ? Math.max(0, Math.min(1, (day - t.es) / t.duration)) : Number(day >= t.es)), 0) / rows.length
          : i === 0 && hasStages
            ? day > 0 ? 1 : 0
            : null,
      };
    });
    return { phases, progress: hasStages ? sceneProgress(r, day) : 0 };
  }
  function mountScene() {
    const r = calc();
    let previewStage = null, earthworkPreview = null, constructionStepIndex = null;
    let current = modelProgress(r, sceneDay);
    scene = new BuildScene($("#project-canvas"), () => current.progress);
    const cameraTools=document.createElement('div');cameraTools.className='camera-tools';cameraTools.innerHTML=DOMPurify.sanitize('<button data-camera-action="in" aria-label="Phóng to mô hình">+</button><button data-camera-action="out" aria-label="Thu nhỏ mô hình">−</button><button data-camera-action="reset" aria-label="Căn vừa mô hình">⤢</button><button class="camera-place" data-camera-action="site">Công trình</button>');cameraTools.hidden=!scene.adjustCamera;$('.scene-canvas-wrap').append(cameraTools);
    const update = () => {
      current = modelProgress(r, sceneDay);
      const process=$(`[data-process-scope="project"]`);if(process&&constructionStepIndex===null){process.querySelector("select").value="plan";process.querySelector(".process-counter").textContent="THEO NGÀY KẾ HOẠCH";}
      if (earthworkPreview !== null) current.progress = earthworkPreview;
      if(constructionStepIndex!==null)current.progress=ConstructionSequence.steps[constructionStepIndex].p;
      if (previewStage !== null)
        current.progress = BuildScene.phaseMiddle(previewStage);
      $("#scene-day-label").textContent = `Ngày ${sceneDay} / ${r.duration}`;
      $("#scene-date").textContent =
        dateLabel(workDate(project(), sceneDay)) +
        " · đầu ngày";
      const equipment = ConstructionEquipment.plan(current.progress);
      $("#machine-status").textContent =
        Object.entries({
          roller: "Xe lu · đầm lớp đất đã rải",
          excavator: "Xe đào",
          dumpTruck: "Xe ben chở đất",
          mixer: "Xe bồn bê tông",
          pump: "Xe bơm bê tông",
        })
          .filter(([key]) => equipment[key])
          .map(([, label]) => label)
          .join("  ·  ") ||
        (current.progress >= 0.98 ? "Công trình hoàn thành · đã rút xe máy" : current.progress >= 0.4 ? "Không cần xe cơ giới ở bước này · cẩu tháp cấp vật tư" : "Không có xe cơ giới ở bước này");
      const active = r.rows.filter((t) => t.es <= sceneDay && t.ef > sceneDay);
      $("#scene-stage-label").textContent = active.length
        ? active.map((t) => t.name).join(" · ")
        : sceneDay >= r.duration
          ? "Hoàn thành toàn bộ kế hoạch"
          : sceneDay > 0
            ? "Gián đoạn công nghệ · chờ công tác tiếp theo"
            : "Chưa bắt đầu công việc";
      if (previewStage !== null) {
        $("#scene-stage-label").textContent =
          "Minh họa: " + PHASES[previewStage];
        $("#scene-date").textContent = "Giai đoạn chưa gắn công việc";
        $("#scene-day-label").textContent = "Đang xem mẫu";
      }
      const detail =
          ConstructionRebar.details[scene.detailMode] ||
          ConstructionRebar.details.auto,
        inspect = scene.detailMode !== "auto";
      $("#detail-note").hidden = !inspect && earthworkPreview === null && constructionStepIndex===null;
      if(constructionStepIndex!==null){const step=ConstructionSequence.steps[constructionStepIndex];$('#scene-stage-label').textContent=step.name;$('#scene-date').textContent='Minh họa theo bước';$('#scene-day-label').textContent='Bước '+(constructionStepIndex+1);$('#detail-note').textContent=step.note||'Công tác minh họa; dùng kế hoạch dự án để xem ngày thực hiện.';const wrap=$('[data-process-scope="project"]');if(wrap){wrap.querySelector('select').value=constructionStepIndex;wrap.querySelector('.process-counter').textContent='BƯỚC '+(constructionStepIndex+1)+' / '+ConstructionSequence.steps.length;}}

      if (earthworkPreview !== null) {
        const compacting = ConstructionEquipment.earthwork(earthworkPreview).compacting, concreting = earthworkPreview < .32;
        $("#scene-stage-label").textContent = concreting ? "Bê tông móng · sau cốt thép và ván khuôn" : compacting ? "San và lu/đầm lớp đất đắp" : "Lấp đất sau công tác móng · rải từng lớp";
        $("#scene-date").textContent = concreting ? "Minh họa công tác móng" : "Lớp minh họa " + ConstructionEquipment.earthwork(earthworkPreview).lift + " / 4 · không phải chiều dày thiết kế";
        $("#scene-day-label").textContent = "Đang xem mẫu";
        $("#detail-note").textContent = concreting ? "Đào đất → bê tông lót → cốt thép và ván khuôn → bê tông móng → bảo dưỡng, tháo khuôn theo yêu cầu → lấp đất. Trình tự tham khảo slide CI5405, chương 3 trang 17 và 24." : "Đất được rải, san rồi lu/đầm và kiểm tra từng lớp trước khi đắp lớp tiếp theo. Xe lu minh họa trên dải nền rộng phía sau nhà; quanh móng và vị trí hẹp dùng thiết bị đầm phù hợp. Không suy ra chiều dày lớp hoặc độ chặt từ mô hình.";
      }
      if (inspect) {
        $("#scene-stage-label").textContent = detail.label;
        $("#scene-date").textContent = "Chi tiết cấu tạo minh họa";
        $("#scene-day-label").textContent = "Xem chi tiết";
        $("#machine-status").textContent =
          "Cốt thép · bê tông · trình tự thi công";
        $("#detail-note").textContent =
          detail.description +
          " Cấu tạo minh họa, không dùng làm bản vẽ thi công.";
      }
      $$("[data-detail-mode]").forEach((button) => {
        button.setAttribute(
          "aria-pressed",
          String(button.dataset.detailMode === scene.detailMode),
        );
      });
      $("#phase-summary").innerHTML = DOMPurify.sanitize(
        current.phases
          .map(
            (p, i) =>
              `<button type="button" data-seek-phase="${i}" class="phase-card ${p.value !== null && p.value > 0 && p.value < 1 ? "active" : ""}"><span class="phase-num">0${i + 1} / ${p.value === null ? "CHƯA GẮN CÔNG VIỆC" : p.value >= 1 ? "HOÀN THÀNH" : p.value > 0 ? "ĐANG THỰC HIỆN" : "CHƯA BẮT ĐẦU"}</span><h3>${p.name}</h3><p>${p.rows.length ? p.rows.map((t) => escape(t.id)).join(" · ") : i === 0 ? "Bước chuẩn bị minh họa" : "Gắn giai đoạn khi tạo công việc"}</p><div class="phase-progress"><b style="width:${(p.value || 0) * 100}%"></b></div></button>`,
          )
          .join(""),
      );
    };
    $("#scene-slider").addEventListener("input", (e) => {
      scene.focusFloor=null;
      constructionStepIndex=null;
      scene.detailMode = "auto";
      previewStage = null; earthworkPreview = null;
      sceneDay = Number(e.target.value);
      update();
    });
    window.updateProjectScene = update;
    window.seekConstructionStep=(index)=>{clearInterval(sceneTimer);sceneTimer=null;$("#play-scene").textContent="▶ Chạy";scene.detailMode="auto";previewStage=null;earthworkPreview=null;if(index==='plan'){constructionStepIndex=null;scene.focusFloor=null;}else{constructionStepIndex=Math.max(0,Math.min(ConstructionSequence.steps.length-1,Number(index)));const step=ConstructionSequence.steps[constructionStepIndex];scene.focusFloor=Number(step.group.match(/^Tầng (\d+)$/)?.[1])||null;scene.setShot?.(step.p);}scene.dirty=true;update();};
    window.resumeProjectScene = () => {
      constructionStepIndex=null;
      previewStage = null; earthworkPreview = null;
      scene.detailMode = "auto";
    };
    window.showConstructionDetail = (mode) => {
      earthworkPreview = null;
      if (!ConstructionRebar.details[mode]) return;
      clearInterval(sceneTimer);
      sceneTimer = null;
      $("#play-scene").textContent = "▶ Chạy";
      scene.detailMode = mode;
      scene.dirty = true;
      update();
    };
    window.previewEarthwork = (progress) => {
      clearInterval(sceneTimer); sceneTimer = null;
      $("#play-scene").textContent = "▶ Chạy";
      previewStage = null; earthworkPreview = Number(progress);
      scene.detailMode = "auto"; scene.dirty = true; update();
    };
    window.seekProjectPhase = (index, end = false) => {
      constructionStepIndex=null;
      earthworkPreview = null;
      scene.detailMode = "auto";
      clearInterval(sceneTimer);
      sceneTimer = null;
      $("#play-scene").textContent = "▶ Chạy";
      const tasks = r.rows.filter((t) => phaseFor(t) === index);
      if (!tasks.length) {
        previewStage = index;
        update();
        return;
      }
      previewStage = null; earthworkPreview = null;
      const first = Math.min(...tasks.map((t) => t.es)),
        last = Math.max(...tasks.map((t) => t.ef));
      sceneDay = Math.min(
        r.duration,
        Math.floor(end ? last : first + (last - first) * 0.55),
      );
      $("#scene-slider").value = sceneDay;
      update();
    };
    update();
  }
  const empty = (title, text, action, label) =>
    `<div class="empty-state"><h3>${title}</h3><p>${text}</p>${action ? `<button class="btn primary" data-action="${action}">${label}</button>` : ""}</div>`;
  function historyHTML(items) {
    return items?.length
      ? `<div class="history-list">${items.map((i) => `<div class="history-item">${escape(i.text)}<small>${new Date(i.at).toLocaleString("vi-VN", { timeZone: "Asia/Bangkok" })}${i.actor ? " · " + escape(i.actor) : ""}</small></div>`).join("")}</div>`
      : '<div class="panel-body form-caption">Chưa có thay đổi được lưu trong dự án này.</div>';
  }
  function estimateView() {
    const p = project(),
      e = CT.estimate(p.boq, p.estimate);
    return (
      heading(
        "Dự toán khối lượng",
        "Đơn giá nhập theo một đơn vị công tác; tất cả số tiền dùng cùng loại tiền của dự án.",
        `<button class="btn ghost" data-action="estimate-settings">Tỷ lệ & chi phí</button><button class="btn ghost" data-action="boq-csv">↓ CSV</button><button class="btn primary" data-action="add-boq">+ Thêm công tác</button>`,
      ) +
      `<div class="kpi-grid">${kpi("Chi phí trực tiếp", shortMoney(e.direct), "Vật liệu + nhân công + máy", "accent")}${kpi("Chung, TL & khác", shortMoney(e.overhead + e.profit + e.other), "Chi phí chung " + pct(p.estimate.overhead) + " · TL " + pct(p.estimate.profit ?? 0))}${kpi("Dự phòng", shortMoney(e.contingency), pct(p.estimate.contingency) + " × tổng trước dự phòng")}${kpi("Tổng dự toán", shortMoney(e.total), "Gồm thuế GTGT " + pct(p.estimate.vat))}</div>` +
      panel(
        "Bảng khối lượng & đơn giá",
        "Dữ liệu mẫu minh họa · bấm dòng để sửa",
        p.boq.length
          ? `<div class="table-scroll"><table><thead><tr><th>Công tác</th><th>Gắn CV</th><th>ĐVT</th><th>Khối lượng</th><th>VL / đơn vị</th><th>NC / đơn vị</th><th>Máy / đơn vị</th><th>Thành tiền</th></tr></thead><tbody>${e.lines.map((i) => `<tr class="click-row" data-edit-boq="${escape(i.id)}"><td class="task-name">${escape(i.name)}</td><td>${escape(i.task) || "—"}</td><td>${escape(i.unit)}</td><td class="num">${num(i.qty, 3)}</td><td class="num">${num(i.material)}</td><td class="num">${num(i.labor)}</td><td class="num">${num(i.machine)}</td><td class="num"><strong>${money(i.total)}</strong></td></tr>`).join("")}</tbody></table></div>`
          : empty(
              "Dự toán bắt đầu từ khối lượng",
              "Thêm công tác, đơn vị, khối lượng và ba thành phần đơn giá.",
              "add-boq",
              "+ Thêm công tác",
            ),
        '<span class="currency-label">' + escape(p.currency) + "</span>",
      ) +
      `<div class="grid-two equal-columns">${panel(
        "Tổng hợp kinh phí",
        "Mô hình lập dự toán nội bộ",
        `<div class="panel-body">${[
          ["Chi phí trực tiếp T", e.direct],
          ["Chi phí chung C (" + pct(p.estimate.overhead) + " × T)", e.overhead],
          ["Thu nhập chịu thuế tính trước TL (" + pct(p.estimate.profit ?? 0) + " × (T + C))", e.profit],
          ["Chi phí khác", e.other],
          ["Dự phòng (" + pct(p.estimate.contingency) + ")", e.contingency],
          ["Thuế GTGT (" + pct(p.estimate.vat) + " × giá trước thuế)", e.vat],
        ]
          .map(
            ([k, v]) =>
              `<div class="stat-row"><span>${k}</span><b>${money(v)}</b></div>`,
          )
          .join(
            "",
          )}<div class="stat-row total"><span>Tổng cộng</span><b>${money(e.total)}</b></div></div>`,
      )}${panel("Nối dự toán với kế hoạch", "Kiểm soát rõ nguồn ngân sách từng công việc", `<div class="panel-body"><p class="form-caption">Các dòng dự toán được gắn mã công việc có thể tổng hợp thành ngân sách trực tiếp của công việc đó. Công việc chưa có dòng gắn sẽ giữ ngân sách hiện tại. Chi phí chung, thuế và dự phòng được giữ ở cấp dự toán.</p><button style="margin-top:20px" class="btn primary small" data-action="sync-boq">Cập nhật ngân sách từ khối lượng ↗</button><p class="form-caption" style="margin-top:18px">Công thức, tỷ lệ và đơn giá trong bản này do người dùng nhập. Chưa tích hợp định mức, bộ đơn giá địa phương, chỉ số giá hoặc mẫu dự toán theo văn bản pháp luật.</p></div>`)}</div>`
    );
  }
  function costsView() {
    const p = project(),
      r = calc(),
      ev = CT.evm(r.rows, p.statusDay),
      direct = r.rows.reduce((s, t) => s + t.cost, 0);
    let opt = "";
    if (optimization) {
      const best = optimization.best;
      opt = `<div class="callout"><strong>Phương án thấp nhất trong ${fmt(optimization.combinations)} tổ hợp: ${best.duration} ngày · ${money(best.total)}.</strong><br>Rút ngắn: ${best.reductions.map((x) => escape(x.id) + " −" + x.days + " ngày").join(", ") || "Giữ nguyên thời lượng"}. Chi phí trực tiếp ${money(best.direct)}, gián tiếp ${money(best.indirect)}.</div>${costChart(optimization.scenarios)}<div class="table-scroll"><table><thead><tr><th>Thời gian</th><th>Trực tiếp</th><th>Gián tiếp</th><th>Tổng</th><th>Rút ngắn</th><th></th></tr></thead><tbody>${optimization.scenarios.map((s) => `<tr><td><strong>${s.duration} ngày</strong> ${s === best ? '<span class="badge">Thấp nhất</span>' : ""}</td><td class="num">${money(s.direct)}</td><td class="num">${money(s.indirect)}</td><td class="num"><strong>${money(s.total)}</strong></td><td>${s.reductions.map((x) => escape(x.id) + " −" + x.days).join(", ") || "Giữ nguyên"}</td><td><button class="text-link" data-apply-scenario="${s.duration}">Áp dụng</button></td></tr>`).join("")}</tbody></table></div>`;
    }
    return (
      heading(
        "Chi phí & tối ưu",
        "Theo dõi ngân sách, hiệu suất và đánh đổi giữa thời gian với chi phí.",
        `<button class="btn ghost" data-action="cost-settings">Cài đặt chi phí gián tiếp</button><button class="btn primary" data-action="optimize" id="optimize-btn">Phân tích rút ngắn ↗</button>`,
      ) +
      `<div class="kpi-grid">${kpi("Ngân sách công việc", shortMoney(direct), "Chi phí trực tiếp đang nhập", "accent")}${kpi("Thực tế AC", shortMoney(ev.ac), "Cập nhật theo từng công việc")}${kpi("CPI · hiệu suất chi phí", ev.cpi === null ? "—" : fmt(ev.cpi, 2), "EV / AC · dưới 1 là kém kế hoạch", ev.cpi !== null && ev.cpi < 1 ? "danger" : "")}${kpi("SPI · hiệu suất tiến độ", ev.spi === null ? "—" : fmt(ev.spi, 2), "EV / PV · báo cáo cuối ngày " + p.statusDay + (p.statusDay > 0 ? " (" + dateLabel(workDate(p, p.statusDay - 1)) + ")" : ""), ev.spi !== null && ev.spi < 1 ? "danger" : "")}</div>` +
      `<div class="grid-two equal-columns">${panel(
        "Giá trị đạt được · EVM",
        "PV dùng kế hoạch hiện tại, phân bổ tuyến tính theo thời lượng",
        `<div class="panel-body">${[
          ["PV · giá trị theo kế hoạch", ev.pv],
          ["EV · giá trị đạt được", ev.ev],
          ["CV = EV − AC", ev.cv],
          ["SV = EV − PV", ev.sv],
        ]
          .map(
            ([k, v]) =>
              `<div class="stat-row"><span>${k}</span><b>${money(v)}</b></div>`,
          )
          .join(
            "",
          )}<div class="stat-row total"><span>EAC = BAC / CPI</span><b>${ev.eac === null ? "Chưa đủ dữ liệu" : money(ev.eac)}</b></div>${[["ETC = EAC − AC · còn phải chi", ev.etc], ["VAC = BAC − EAC · chênh lệch khi hoàn thành", ev.vac], ["EAC nếu phần còn lại đúng ngân sách = AC + (BAC − EV)", ev.eacBudget], ["EAC theo CPI × SPI = AC + (BAC − EV) / (CPI × SPI)", ev.eacCpiSpi]].map(([k, v]) => `<div class="stat-row"><span>${k}</span><b>${v === null ? "—" : money(v)}</b></div>`).join("")}<div class="stat-row"><span>TCPI = (BAC − EV) / (BAC − AC)</span><b>${ev.tcpi === null ? "—" : fmt(ev.tcpi, 2)}</b></div><p class="form-caption">EAC giả định hiệu suất chi phí hiện tại tiếp tục; TCPI &gt; 1 nghĩa là phần việc còn lại phải hiệu quả hơn mới giữ được ngân sách. % hoàn thành được nhân với ngân sách, không thay thế biên bản nghiệm thu.</p></div>`,
      )}${panel("Giả định rút ngắn tiến độ", "Tìm đầy đủ các tổ hợp trong phạm vi cho phép", `<div class="panel-body"><div class="stat-row"><span>Chi phí gián tiếp tại ${CT.schedule(p.tasks).duration} ngày (CPM theo thời lượng đang nhập)</span><b>${money(p.indirectBase)}</b></div><div class="stat-row"><span>Giảm chi phí gián tiếp / ngày</span><b>${money(p.dailySaving)}</b></div><div class="stat-row"><span>Tổng trước rút ngắn</span><b>${money(direct + p.indirectBase)}</b></div><p class="form-caption" style="margin-top:18px">Mỗi công việc có thời lượng tối thiểu và chi phí tăng thêm/ngày. Mỗi tổ hợp đều tính lại đường găng. Gián tiếp được chặn tại 0; bước rút ngắn là 1 ngày, tối đa 50.000 tổ hợp.</p><button class="text-link" style="margin-top:15px" data-action="sample-textbook">Thử bài mẫu trong tài liệu Word ↗</button></div>`)}</div>` +
      panel(
        "Các phương án thời gian–chi phí",
        optimization
          ? "Chi phí nhỏ nhất ứng với từng thời lượng khả thi"
          : "Chọn “Phân tích rút ngắn” để so sánh phương án",
        opt
          ? `<div class="panel-body" style="padding-bottom:0">${opt}</div>`
          : empty(
              "Rút ngắn đến đâu là hợp lý?",
              "Cập nhật thời lượng tối thiểu và chi phí tăng thêm trong từng công việc, sau đó chạy phân tích.",
              "optimize",
              "Phân tích phương án",
            ),
      )
    );
  }
  /** Đường tổng / trực tiếp theo thời lượng; trục chi phí co theo dữ liệu để thấy được chênh lệch. */
  function costChart(rows) {
    if (rows.length < 2) return "";
    const sorted = [...rows].sort((a, b) => a.duration - b.duration);
    const W = 830, H = 240, L = 92, R = 20, T = 22, B = 40;
    const lo = sorted[0].duration, hi = sorted[sorted.length - 1].duration;
    const values = sorted.flatMap((r) => [r.total, r.direct]);
    let min = Math.min(...values), max = Math.max(...values);
    const pad = Math.max((max - min) * 0.12, Math.abs(max) * 0.002, 1);
    min -= pad;
    max += pad;
    const x = (t) => L + ((t - lo) / Math.max(1, hi - lo)) * (W - L - R);
    const y = (v) => T + (1 - (v - min) / (max - min)) * (H - T - B);
    const line = (k) => sorted.map((r, i) => (i ? "L" : "M") + x(r.duration).toFixed(1) + " " + y(r[k]).toFixed(1)).join(" ");
    const best = sorted.reduce((a, b) => (b.total < a.total ? b : a));
    const grid = [0, 0.25, 0.5, 0.75, 1]
      .map((q) => {
        const v = min + (max - min) * q;
        return `<path d="M${L} ${y(v)}H${W - R}" class="chart-line"/><text x="${L - 8}" y="${y(v) + 4}" text-anchor="end" class="chart-label">${shortMoney(v)}</text>`;
      })
      .join("");
    const every = Math.max(1, Math.ceil(sorted.length / 14));
    const points = sorted
      .map((r, i) => {
        const dot = `<circle cx="${x(r.duration)}" cy="${y(r.total)}" r="${r === best ? 6 : 4}" class="${r === best ? "chart-best" : "chart-point"}"><title>${r.duration} ngày · tổng ${money(r.total)} · trực tiếp ${money(r.direct)} · gián tiếp ${money(r.indirect)}</title></circle>`;
        const tick = i % every === 0 || r === best ? `<text x="${x(r.duration)}" y="${H - 16}" text-anchor="middle" class="chart-label">${r.duration}n</text>` : "";
        return dot + tick;
      })
      .join("");
    return `<svg class="finance-chart cost-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Tổng chi phí và chi phí trực tiếp theo thời lượng">${grid}<path d="${line("direct")}" class="chart-series direct"/><path d="${line("total")}" class="chart-series total"/>${points}<text x="${x(best.duration)}" y="${y(best.total) - 12}" text-anchor="${x(best.duration) > W - 90 ? "end" : x(best.duration) < L + 60 ? "start" : "middle"}" class="chart-label strong">Thấp nhất ${best.duration}n</text><text x="${L}" y="12" class="chart-label">— Tổng chi phí   - - Chi phí trực tiếp · gián tiếp = tổng − trực tiếp (xem bảng)</text></svg>`;
  }
  function financeView() {
    const p = project(),
      f = p.finance,
      l = CT.loan(f.principal, f.rate, f.months, f.method),
      a = CT.appraisal(f.flows, f.discount),
      fvSimple = f.principal * (1 + ((f.rate / 100) * f.months) / 12),
      fvCompound = f.principal * Math.pow(1 + f.rate / 1200, f.months);
    return (
      heading(
        "Tài chính & lãi vay",
        "Tính lãi trên dư nợ giảm dần và phân tích dòng tiền với các giả định minh bạch.",
        `<button class="btn ghost" data-action="loan-csv">↓ Lịch trả nợ CSV</button>`,
      ) +
      `<div class="kpi-grid">${kpi("Số tiền vay", shortMoney(f.principal), pct(f.rate) + "/năm · " + f.months + " tháng", "accent")}${kpi("Tổng lãi vay", shortMoney(l.interest), "Lãi danh nghĩa năm / 12 mỗi tháng")}${kpi("NPV", shortMoney(a.npv), "Chiết khấu " + pct(f.discount) + " mỗi năm", a.npv < 0 ? "danger" : "")}${kpi("IRR", a.irr === null ? "—" : fmt(a.irr * 100, 2), a.irr === null ? "Xem điều kiện nghiệm bên dưới" : "Theo kỳ năm của dòng tiền", "", "%")}</div>` +
      `<div class="grid-two equal-columns">${panel(
        "Vay vốn & lịch trả nợ",
        "Giải ngân một lần, trả cuối tháng, lãi suất cố định",
        `<div class="panel-body"><form data-form="finance-loan" class="form-grid">${field("principal", "Số tiền vay", f.principal, "number", 'min="0" max="1000000000000000" step="any"')}${field("rate", "Lãi suất danh nghĩa (%/năm)", f.rate, "number", 'min="0" max="100" step="any"')}${field("months", "Thời hạn (tháng)", f.months, "number", 'min="1" max="600" step="1"')}${selectField(
          "method",
          "Cách trả nợ",
          f.method,
          [
            ["annuity", "Tổng trả hằng tháng đều"],
            ["principal", "Gốc đều, lãi giảm dần"],
          ],
        )}<div class="field wide"><button class="btn primary" type="submit">Tính & lưu phương án vay ↗</button></div></form><p style="margin-top:18px" class="form-caption">Chưa gồm phí, bảo hiểm, ân hạn, lãi thả nổi hoặc quy ước số ngày thực tế của ngân hàng. Khoản cuối điều chỉnh sai số để dư nợ bằng 0.</p></div>`,
      )}${panel("Hiệu quả đầu tư · NPV / IRR", "Dòng tiền ròng cách đều theo năm, phát sinh cuối kỳ", `<div class="panel-body"><form data-form="finance-flows" class="form-stack"><div class="field"><label for="f-flows">Dòng tiền từ kỳ 0, mỗi dòng một số</label><textarea id="f-flows" name="flows" class="flow-input" required>${f.flows.map((v) => num(v, 2)).join("\n")}</textarea><small>Kỳ 0 thường âm (vốn đầu tư). Kỳ 1 trở đi là thu − chi. Nhập kiểu Việt Nam: -1.000.000.000 hoặc 2,5 (dấu phẩy thập phân).</small></div>${field("discount", "Suất chiết khấu (%/năm)", f.discount, "number", 'min="0" max="100" step="any"')}<button class="btn primary" type="submit">Phân tích dòng tiền ↗</button></form><p class="form-caption" style="margin-top:14px">${a.irrNote ? escape(a.irrNote) : "IRR là nghiệm làm NPV bằng 0. Dòng tiền hiện tại chỉ đổi dấu một lần."}</p><div class="stat-row"><span>Hoàn vốn giản đơn</span><b>${a.payback === null ? "Chưa hoàn vốn" : num(a.payback, 2) + " năm"}</b></div><div class="stat-row"><span>Hoàn vốn có chiết khấu</span><b>${a.discountedPayback === null ? "Chưa hoàn vốn" : num(a.discountedPayback, 2) + " năm"}</b></div><div class="stat-row"><span>Chỉ số sinh lời PI = PV thu / PV chi</span><b>${a.pi === null ? "—" : num(a.pi, 2)}</b></div></div>`)}</div>` +
      `<div class="grid-two equal-columns">${panel("Giá trị thời gian của tiền", "So sánh trên chính số tiền, lãi suất và thời hạn vay ở trên", `<div class="panel-body"><div class="stat-row"><span>FV lãi đơn · P × (1 + r × tháng/12)</span><b>${money(fvSimple)}</b></div><div class="stat-row"><span>FV lãi kép · P × (1 + r/12)<sup>tháng</sup></span><b>${money(fvCompound)}</b></div><div class="stat-row"><span>PV của khoản P nhận cuối kỳ</span><b>${money(f.principal / Math.pow(1 + f.rate / 1200, f.months))}</b></div><p class="form-caption" style="margin-top:15px">r ở công thức là lãi suất năm dạng thập phân. Đây là tích lũy không trả giữa kỳ; khác với lịch vay trả nợ hằng tháng.</p></div>`)}${panel("Tổng nghĩa vụ trả nợ", "Tách rõ gốc và lãi để tránh cộng trùng", `<div class="panel-body"><div class="stat-row"><span>Vốn gốc</span><b>${money(f.principal)}</b></div><div class="stat-row"><span>Tổng lãi</span><b>${money(l.interest)}</b></div><div class="stat-row total"><span>Tổng thanh toán</span><b>${money(l.total)}</b></div><div class="stat-row"><span>Thanh toán tháng đầu</span><b>${money(l.rows[0].payment)}</b></div><p class="form-caption">Các kịch bản vay, dòng tiền và dự toán được tính riêng. Chưa tự cộng lãi vay vào tổng dự toán; bạn quyết định khoản nào đưa vào dòng tiền dự án.</p></div>`)}</div>` +
      panel(
        "Lịch trả nợ chi tiết",
        f.method === "annuity"
          ? "Trả tổng tiền đều mỗi tháng"
          : "Trả vốn gốc đều mỗi tháng",
        `<div class="table-scroll" style="max-height:380px"><table><thead><tr><th>Tháng</th><th>Gốc trả</th><th>Lãi trả</th><th>Tổng trả</th><th>Dư nợ cuối kỳ</th></tr></thead><tbody>${l.rows.map((r) => `<tr><td>${r.month}</td>${["capital", "interest", "payment", "balance"].map((k) => `<td class="num">${money(r[k])}</td>`).join("")}</tr>`).join("")}</tbody></table></div>`,
      ) +
      panel(
        "Dòng tiền theo kỳ",
        "Số tiền cùng đơn vị " + escape(p.currency),
        `<div class="panel-body">${cashflowChart(f.flows)}</div>`,
      )
    );
  }
  /** Cột dòng tiền theo kỳ; nhiều kỳ thì gộp nhóm, nhãn ghi đúng số kỳ thật. */
  function cashflowChart(flows) {
    const group = Math.max(1, Math.ceil(flows.length / 40));
    const bars = [];
    for (let i = 0; i < flows.length; i += group) {
      const part = flows.slice(i, i + group);
      bars.push({ from: i, to: i + part.length - 1, value: part.reduce((s, v) => s + v, 0) });
    }
    const W = 800, H = 230, L = 70, R = 15, mid = 108, span = 82;
    const max = Math.max(1, ...bars.map((b) => Math.abs(b.value))), bw = (W - L - R) / bars.length;
    let running = 0;
    const cum = bars.map((b) => (running += b.value));
    const cmax = Math.max(1, ...cum.map(Math.abs));
    const every = Math.max(1, Math.ceil(bars.length / 12));
    const label = (b) => (b.from === b.to ? "Kỳ " + b.from : "Kỳ " + b.from + "–" + b.to);
    const columns = bars
      .map((b, i) => {
        const h = (Math.abs(b.value) / max) * span, x = L + i * bw;
        const rect = `<rect x="${x + bw * 0.2}" y="${b.value >= 0 ? mid - h : mid}" width="${Math.max(2, bw * 0.6)}" height="${Math.max(0.5, h)}" rx="2" class="${b.value >= 0 ? "bar-in" : "bar-out"}"><title>${label(b)}: ${money(b.value)} · lũy kế ${money(cum[i])}</title></rect>`;
        const tick = i % every === 0 ? `<text x="${x + bw / 2}" y="${H - 8}" text-anchor="middle" class="chart-label">${b.from}</text>` : "";
        return rect + tick;
      })
      .join("");
    const cumulative = cum.map((v, i) => (i ? "L" : "M") + (L + i * bw + bw / 2).toFixed(1) + " " + (mid - (v / cmax) * span).toFixed(1)).join(" ");
    return `<svg class="finance-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Dòng tiền dương và âm theo kỳ"><path d="M${L - 5} ${mid}H${W - R}" class="chart-axis"/><text x="${L - 10}" y="${mid - span + 4}" text-anchor="end" class="chart-label">${shortMoney(max)}</text><text x="${L - 10}" y="${mid + span + 4}" text-anchor="end" class="chart-label">${shortMoney(-max)}</text>${columns}<path d="${cumulative}" class="chart-series cumulative"/><text x="${L}" y="14" class="chart-label">Cột: dòng tiền ròng theo kỳ${group > 1 ? " (gộp " + group + " kỳ)" : ""} · đường: lũy kế (thang riêng)</text></svg>`;
  }
  function resourceDays(r) {
    if (!r.duration) return [];
    const diff = new Float64Array(r.duration + 1);
    r.rows.forEach((t) => {
      if (t.duration) {
        diff[t.es] += t.workers;
        diff[t.ef] -= t.workers;
      }
    });
    let count = 0;
    return Array.from({ length: r.duration }, (_, day) => ({
      day,
      people: (count += diff[day]),
    }));
  }
  function resourcesView() {
    const p = project(),
      r = calc(),
      days = resourceDays(r),
      max = Math.max(0, ...days.map((x) => x.people)),
      over = days.filter((x) => x.people > p.capacity).length,
      work = days.reduce((s, x) => s + x.people, 0),
      owners = [...new Set(p.tasks.map((t) => t.owner || "Chưa phân công"))];
    return (
      heading(
        "Nguồn lực nhân công",
        "Nhu cầu nhân công của lịch đang áp dụng, giả định nhân lực cố định trong mỗi công việc.",
        `<button class="btn primary" data-action="settings">Cài đặt năng lực ↗</button>`,
      ) +
      `<div class="kpi-grid">${kpi("Nhu cầu cao nhất", fmt(max), "Theo lịch đang áp dụng", "accent", "người")}${kpi("Năng lực hiện có", fmt(p.capacity), "Giới hạn nhân công tổng thể", "", "người")}${kpi("Ngày vượt năng lực", over, "Cần điều chỉnh kế hoạch hoặc bổ sung người", over ? "danger" : "", "ngày")}${kpi("Tổng hao phí nhân công", fmt(work), "Σ số người × thời lượng", "", "công")}</div>` +
      panel(
        "Biểu đồ nhu cầu nhân công",
        "Đường gạch biểu diễn năng lực hiện có",
        `<div class="panel-body">${resourceChart(days, p.capacity)}</div><div class="data-note">Nếu tiến độ dài, mỗi cột biểu diễn mức cao nhất trong nhóm ngày. Vào Tiến độ → Xếp & tối ưu để điều phối nguồn lực. Chưa chia theo nghề hoặc tổ đội.</div>`,
      ) +
      panel(
        "Phân công theo người phụ trách",
        "Đầu mối quản lý công việc, không phải số nhân công trực tiếp",
        `<div class="table-scroll"><table><thead><tr><th>Phụ trách</th><th>Công việc</th><th>Công việc găng</th><th>Ngân sách</th><th>Thực tế</th></tr></thead><tbody>${owners
          .map((o) => {
            const ts = r.rows.filter(
              (t) => (t.owner || "Chưa phân công") === o,
            );
            return `<tr><td><strong>${escape(o)}</strong></td><td>${ts.map((t) => escape(t.id)).join(" · ")}</td><td>${ts.filter((t) => t.critical).length}</td><td class="num">${money(ts.reduce((s, t) => s + t.cost, 0))}</td><td class="num">${money(ts.reduce((s, t) => s + t.actualCost, 0))}</td></tr>`;
          })
          .join("")}</tbody></table></div>`,
      )
    );
  }
  /** Biểu đồ nhân lực: cột theo ngày (gộp khi dài), đường năng lực và đường trung bình Rtb. */
  function resourceChart(days, capacity) {
    if (!days.length) return '<p class="form-caption">Chưa có dữ liệu nhân công.</p>';
    const peak = Math.max(...days.map((d) => d.people), 0);
    // Trục tung tròn số (bội 5/10/20…) để đọc nhanh.
    const raw = Math.max(capacity, peak, 1) * 1.08, unit = raw <= 20 ? 5 : raw <= 60 ? 10 : raw <= 200 ? 20 : 50;
    const max = Math.ceil(raw / unit) * unit;
    const average = days.reduce((s, d) => s + d.people, 0) / days.length;
    const bin = Math.ceil(days.length / 80), bins = [];
    for (let i = 0; i < days.length; i += bin)
      bins.push({ day: i, last: Math.min(days.length, i + bin) - 1, people: Math.max(...days.slice(i, i + bin).map((d) => d.people)) });
    const W = 800, H = 260, L = 46, R = 14, T = 16, B = 34;
    const bw = (W - L - R) / bins.length, y = (v) => T + (1 - v / max) * (H - T - B);
    const every = Math.max(1, Math.ceil(bins.length / 12));
    const ticks = [0, 0.25, 0.5, 0.75, 1]
      .map((q) => `<path d="M${L} ${y(q * max)}H${W - R}" class="chart-line"/><text x="${L - 6}" y="${y(q * max) + 4}" text-anchor="end" class="chart-label">${num(q * max, 0)}</text>`)
      .join("");
    const bars = bins
      .map((d, i) => {
        const rect = `<rect x="${L + i * bw + bw * 0.1}" y="${y(d.people)}" width="${Math.max(1, bw * 0.8)}" height="${Math.max(0, H - B - y(d.people))}" rx="1.5" class="${d.people > capacity + 1e-9 ? "bar-over" : "bar-crew"}"><title>Ngày ${d.day + 1}${d.last > d.day ? "–" + (d.last + 1) : ""}: ${num(d.people, 1)} người</title></rect>`;
        const tick = i % every === 0 ? `<text x="${L + i * bw + bw / 2}" y="${H - 14}" text-anchor="middle" class="chart-label">${d.day + 1}</text>` : "";
        return rect + tick;
      })
      .join("");
    return `<svg class="resource-chart" viewBox="0 0 ${W} ${H}" role="img" aria-label="Biểu đồ nhân công theo ngày làm việc, đỉnh ${num(peak)} người, trung bình ${num(average, 1)} người">${ticks}${bars}<path d="M${L} ${y(capacity)}H${W - R}" class="chart-capacity"/><text x="${W - R}" y="${y(capacity) - 6}" text-anchor="end" class="chart-label strong">Năng lực ${num(capacity)}</text><path d="M${L} ${y(average)}H${W - R}" class="chart-average"/><text x="${L + 4}" y="${y(average) - 6}" class="chart-label">Rtb ${num(average, 1)}</text><text x="${W - R}" y="${H - 1}" text-anchor="end" class="chart-label">Ngày làm việc${bin > 1 ? " (mỗi cột " + bin + " ngày, lấy mức cao nhất)" : ""}</text></svg>`;
  }
  function riskView() {
    const p = project(),
      active = p.risks.filter((x) => x.status !== "Đã đóng"),
      high = active.filter((x) => x.probability * x.impact >= 15).length;
    return (
      heading(
        "Quản lý rủi ro",
        "Sổ rủi ro, người chịu trách nhiệm và phương án ứng phó.",
        `<button class="btn primary" data-action="add-risk">+ Thêm rủi ro</button>`,
      ) +
      `<div class="kpi-grid">${kpi("Rủi ro đang mở", active.length, "Trong tổng số " + p.risks.length + " rủi ro", "accent")}${kpi("Mức ưu tiên cao", high, "Điểm ≥ 15 trên thang 25", high ? "danger" : "")}${kpi("Đang xử lý", p.risks.filter((x) => x.status === "Đang xử lý").length, "Đã có biện pháp đang thực hiện")}${kpi("Đã đóng", p.risks.filter((x) => x.status === "Đã đóng").length, "Lưu lại để rút kinh nghiệm")}</div>` +
      `<div class="grid-two">${panel(
        "Danh mục rủi ro",
        "Bấm một rủi ro để cập nhật",
        p.risks.length
          ? `<div class="table-scroll"><table><thead><tr><th>Rủi ro</th><th>Điểm</th><th>Phụ trách</th><th>Trạng thái</th></tr></thead><tbody>${[...p.risks]
              .sort((a, b) => (a.status === "Đã đóng") - (b.status === "Đã đóng") || b.probability * b.impact - a.probability * a.impact)
              .map((x) => {
                const score = x.probability * x.impact;
                return `<tr class="click-row" data-edit-risk="${escape(x.id)}"><td class="task-name">${escape(x.name)}</td><td><span class="badge ${score >= 15 ? "critical" : score >= 8 ? "warning" : ""}">${x.probability} × ${x.impact} = ${score}</span></td><td>${escape(x.owner) || "—"}</td><td>${escape(x.status)}</td></tr>`;
              })
              .join("")}</tbody></table></div>`
          : empty(
              "Chưa có rủi ro",
              "Ghi lại rủi ro, đánh giá xác suất, tác động và người xử lý.",
              "add-risk",
              "+ Thêm rủi ro",
            ),
      )}${panel(
        "Ma trận xác suất × tác động",
        "Thang 1–5; quy tắc phân nhóm do ứng dụng quy ước",
        `<div class="panel-body"><div class="risk-matrix">${[5, 4, 3, 2, 1]
          .map(
            (prob) =>
              `<span class="risk-axis">${prob}</span>${[1, 2, 3, 4, 5]
                .map((impact) => {
                  const score = prob * impact,
                    count = active.filter(
                      (x) => x.probability === prob && x.impact === impact,
                    ).length;
                  return `<div class="risk-cell ${score >= 15 ? "high" : score >= 8 ? "medium" : "low"}" title="Xác suất ${prob}, tác động ${impact}">${count ? `<b>${count}</b>` : score}</div>`;
                })
                .join("")}`,
          )
          .join(
            "",
          )}<span></span>${[1, 2, 3, 4, 5].map((x) => `<span class="risk-axis">${x}</span>`).join("")}</div><p class="form-caption" style="margin-top:18px">Trục dọc: xác suất. Trục ngang: tác động. Số trong vòng tròn: số rủi ro đang mở tại ô đó.</p></div>`,
      )}</div>`
    );
  }
  function teamView() {
    const p = project(),
      owners = [...new Set(p.tasks.map((t) => t.owner).filter(Boolean))];
    return (
      heading(
        "Thành viên & lịch sử",
        "Phân công rõ đầu mối, theo dõi thay đổi và quyền truy cập.",
        `${team?'<button class="btn ghost" data-action="create-invite">Mời tham gia</button>':''}<button class="btn primary" data-action="team-connect">${team ? "Quản lý tài khoản" : "Kết nối không gian chung"} ↗</button>`,
      ) +
      (!team
        ? '<div class="callout warning">Đang ở chế độ cục bộ. Các tên bên dưới là người phụ trách công việc, chưa phải tài khoản đăng nhập. Chạy bằng máy chủ đi kèm và kết nối để dùng quyền chủ dự án, chỉnh sửa, chỉ xem và chống ghi đè khi nhiều người sửa.</div>'
        : '<div class="callout">Đã đăng nhập <strong>' +
          escape(team.name) +
          "</strong>. Quyền tại dự án hiện tại: " +
          escape({ owner: "chủ dự án", editor: "chỉnh sửa", commenter: "xem và bình luận", viewer: "chỉ xem" }[p._role || "owner"] || p._role) +
          ". Thay đổi được đồng bộ khi bấm lưu.</div>") +
      `<div class="grid-two equal-columns">${panel("Người phụ trách trong kế hoạch", "Giao người phụ trách trong biểu mẫu công việc", `<div class="panel-body">${owners.length ? owners.map((o) => `<div class="member-row"><span><i class="avatar" style="font-style:normal;display:grid;place-items:center">${escape(o.split(" ").slice(-1)[0].slice(0, 2).toUpperCase())}</i>${escape(o)}</span><span class="badge neutral">${p.tasks.filter((t) => t.owner === o).length} công việc</span></div>`).join("") : '<p class="form-caption">Chưa có người phụ trách được gắn vào công việc.</p>'}${team ? '<button style="margin-top:20px" class="btn ghost small" data-action="members">Quản lý quyền dự án ↗</button>' : ""}</div>`)}${panel("Nhật ký cập nhật", "Tối đa 100 mục gần nhất trong bản dữ liệu dự án", historyHTML(p.history))}</div>` + (latestInvite?.projectId===p.id?`<section class="panel"><div class="panel-body"><h3>Liên kết mời · ${escape(latestInvite.role)}</h3><input class="invite-link" value="${escape(latestInvite.url)}" readonly aria-label="Liên kết mời"><button class="btn ghost small" data-action="copy-invite">Sao chép liên kết</button><p class="form-caption">Hiệu lực tới ${new Date(latestInvite.expires).toLocaleString("vi-VN",{timeZone:"Asia/Bangkok"})}. Người nhận cần truy cập được cùng máy chủ; địa chỉ 127.0.0.1 chỉ dùng trên máy đang chạy ứng dụng.</p></div></section>`:"") + commentsHTML()
    );
  }
  const printItems=[['overview','Tổng quan'],['gantt','Biểu đồ Gantt'],['cpm','Thông số CPM'],['network','Sơ đồ mạng & đường găng'],['estimate','Dự toán'],['costs','Chi phí & rút ngắn'],['finance','Tài chính & lãi vay'],['resources','Nguồn lực'],['risk','Rủi ro'],['planning','Phương án xếp lịch'],['model','Cảnh công trình']];
  const printSelected=new Set(['overview','gantt','network']);let exporting=false;
  function printView(){return heading('In & xuất báo cáo','Chọn một hoặc nhiều mục. Tải PDF, ảnh, sao chép ảnh hoặc mở hộp thoại in.')+`<section class="panel"><div class="panel-head"><div><h2>Nội dung muốn xuất</h2><p>${escape(project().name)}</p></div><div class="panel-tools"><button class="btn ghost small" data-action="print-select-all">Chọn tất cả</button><button class="btn ghost small" data-action="print-clear">Bỏ chọn</button></div></div><div class="panel-body"><div class="print-choices">${printItems.map(([id,label])=>`<label><input type="checkbox" data-print-section="${id}" ${printSelected.has(id)?'checked':''}><span>${label}</span></label>`).join('')}</div><div class="export-actions">${[['print','In các mục đã chọn'],['pdf','Tải PDF'],['png','Xuất ảnh PNG'],['clipboard','Sao chép ảnh']].map(([format,label])=>`<button class="btn ${format==='pdf'?'primary':'ghost'}" data-export-format="${format}" ${exporting?'disabled':''}>${label}</button>`).join('')}</div><p class="form-caption">Nhiều ảnh được gói thành một ZIP. PDF khổ A4 ngang; mục dài được chia trang. Ảnh sao chép gồm các mục đã chọn. In dùng trình duyệt để chọn máy in hoặc lưu PDF.</p><p class="form-caption" role="status" id="export-status"></p></div></section>`;}
  async function printSectionHTML(key){const beforeSearch=search,beforeCritical=criticalOnly;search='';criticalOnly=false;try{return await renderPrintSection(key);}finally{search=beforeSearch;criticalOnly=beforeCritical;}}
  async function renderPrintSection(key){
    const r=calc();if(key==='costs'&&['nhom-quan-ly-du-an','bai-tap-a-k'].includes(project().id)){const old=optimization;try{optimization=CT.optimize(project().tasks,project().indirectBase,project().dailySaving);return costsView();}finally{optimization=old;}}if(key==='gantt')return heading('Biểu đồ Gantt','Lịch đang áp dụng')+panel('Tiến độ',r.duration+' ngày làm việc',gantt(r));
    if(key==='cpm'){const old=scheduleTab,oldSearch=search,oldCritical=criticalOnly;scheduleTab='cpm';search='';criticalOnly=false;const html=scheduleView();scheduleTab=old;search=oldSearch;criticalOnly=oldCritical;return html;}
    if(key==='planning'){const d=planningDraft();if(!d.report)throw Error('Chưa có phương án xếp lịch. Giải một phương án trước khi chọn mục này.');return planningReportView(d);}
    if(key==='model'){
      let image;const active=[...BuildScene.instances].find(s=>s.canvas.id==='project-canvas');
      if(active?.renderer){active.renderer.render(active.scene,active.camera);image=active.canvas.toDataURL('image/png');}
      else{const wrap=document.createElement('div');wrap.style.cssText='position:fixed;left:-12000px;top:0;width:1100px;height:700px';const canvas=document.createElement('canvas');canvas.style.cssText='width:1100px;height:700px';wrap.append(canvas);document.body.append(wrap);let scene;try{scene=new BuildScene(canvas,()=>.68);scene.draw(performance.now());if(scene.renderer)scene.renderer.render(scene.scene,scene.camera);image=canvas.toDataURL('image/png');}finally{scene?.destroy();wrap.remove();}}
      return heading('Công trình','Cảnh minh họa kế hoạch thi công')+`<img src="${image}" style="width:100%" alt="Công trình">`;
    }
    return ({overview:overviewView,network:networkView,estimate:estimateView,costs:costsView,finance:financeView,resources:resourcesView,risk:riskView}[key]||overviewView)();
  }
  async function exportPages(format,current=false){
    if(exporting)return;exporting=true;let stage;
    try{
      const keys=current?[page]:printItems.filter(([key])=>printSelected.has(key)).map(([key])=>key);if(!keys.length)throw Error('Chọn ít nhất một mục để xuất.');
      toast(format==='clipboard'?'Đang tạo ảnh để sao chép…':'Đang chuẩn bị báo cáo…');
      stage=document.createElement('div');stage.className='report-staging';stage.id='report-staging';document.body.append(stage);
      for(const key of keys){const section=document.createElement('section');section.className='report-sheet';section.dataset.reportLabel=key;const header=`<div class="report-title"><strong>QUẢN LÝ DỰ ÁN XÂY DỰNG</strong><span>${escape(project().name)} · ${new Date().toLocaleDateString('vi-VN',{timeZone:'Asia/Bangkok'})}</span></div>`;section.innerHTML=DOMPurify.sanitize(header+(current?$('#main').innerHTML:await printSectionHTML(key)));stage.append(section);
        // Preserve current form values in the static report; export controls are removed.
        section.querySelectorAll('button.gantt-label,button.gantt-bar').forEach(button=>{const div=document.createElement('div');div.className=button.className;div.style.cssText=button.style.cssText;div.innerHTML=button.innerHTML;button.replaceWith(div);});
        section.querySelectorAll('.network-wrap svg').forEach(svg=>{const box=svg.getBBox(),width=Math.ceil(box.x+box.width+28),height=Math.ceil(box.y+box.height+28);if(width>1100||height>480){const wrap=svg.parentElement;svg.remove();const tileW=Math.min(1050,width),tileH=Math.min(460,height),xs=[],ys=[];for(let x=0;x<width;x+=tileW-160){xs.push(x);if(x+tileW>=width)break;}for(let y=0;y<height;y+=tileH-100){ys.push(y);if(y+tileH>=height)break;}let n=0;for(const y of ys)for(const x of xs){const part=document.createElement('div');part.className='report-network-tile';const label=document.createElement('p');label.textContent='Sơ đồ · phần '+(++n)+' / '+(xs.length*ys.length)+' · các phần chồng biên để theo dõi liên kết';part.append(label);const clone=svg.cloneNode(true);clone.setAttribute('viewBox',x+' '+y+' '+tileW+' '+tileH);clone.setAttribute('width',String(tileW));clone.setAttribute('height',String(tileH));clone.style.width='100%';clone.style.height='auto';part.append(clone);wrap.append(part);}}});
        section.querySelectorAll('button,.heading-actions,.panel-tools,.tabbar,.plan-submit,.camera-tools,.toast').forEach(e=>e.remove());
        section.querySelectorAll('input,select,textarea').forEach((input,index)=>{const live=current?$('#main').querySelectorAll('input,select,textarea')[index]:null;if(live){input.value=live.value;input.checked=live.checked;}const value=input.tagName==='SELECT'?input.selectedOptions[0]?.textContent:input.type==='checkbox'||input.type==='radio'?(input.checked?'Đã chọn':'Không chọn'):input.value;const span=document.createElement('span');span.className='report-field';span.textContent=value??'';input.replaceWith(span);});
        for(const [i,canvas]of [...section.querySelectorAll('canvas')].entries()){const original=$$('#main canvas')[i];if(original){const scene=[...BuildScene.instances].find(s=>s.canvas===original);scene?.renderer?.render(scene.scene,scene.camera);const img=document.createElement('img');img.src=original.toDataURL('image/png');img.style.width='100%';canvas.replaceWith(img);}else canvas.remove();}
      }
      await Promise.all([...stage.querySelectorAll('img')].map(img=>img.decode().catch(()=>{})));
      await ReportExport.run([...stage.children],format,project().name.replace(/[^\p{L}\p{N}_-]+/gu,'-'));
      toast(format==='clipboard'?'Đã sao chép ảnh báo cáo.':format==='print'?'Đã mở hộp thoại in.':'Đã tạo tệp báo cáo.');
    }catch(error){toast(error.message,true);}finally{exporting=false;if(format!=='print')stage?.remove();}
  }
  function exportCurrentModal(){modal('Xuất trang đang xem',`<p class="form-caption">${escape(names[page]||'Trang hiện tại')} · ${escape(project().name)}</p>${selectField('exportFormat','Định dạng','pdf',[['pdf','PDF'],['png','Ảnh PNG'],['clipboard','Sao chép ảnh vào clipboard'],['print','In / lưu PDF bằng trình duyệt']])}`,(f)=>exportPages(String(f.get('exportFormat')),true),'Xuất trang');}

  let latestInvite=null;
  function commentsHTML(){const p=project();return panel('Bình luận dự án','Mọi thành viên được xem; quyền bình luận được kiểm tra ở máy chủ.',team?`<div class="panel-body">${p._role==='viewer'?'<p class="form-caption">Bạn có quyền chỉ xem.</p>':'<form data-form="comment"><div class="field"><label for="comment-body">Nội dung</label><textarea id="comment-body" name="nen_commentBody" maxlength="5000" rows="3" required placeholder="Trao đổi về tiến độ, khối lượng hoặc phương án…"></textarea></div><button class="btn primary small" type="submit">Gửi bình luận</button></form>'}<button class="text-link" data-action="refresh-comments" style="margin:16px 0">Làm mới bình luận</button><div id="comments-list" aria-live="polite">Đang tải…</div></div>`:'<div class="panel-body"><p>Kết nối không gian chung để mời thành viên và bình luận.</p><button class="btn primary small" data-action="team-connect">Kết nối</button></div>');}
  async function loadComments(){if(!team||!$('#comments-list'))return;const id=project().id;try{const data=await api('/api/projects/'+encodeURIComponent(id)+'/comments');if(project().id!==id||!$('#comments-list'))return;$('#comments-list').innerHTML=DOMPurify.sanitize(data.comments.length?data.comments.map(c=>`<article class="project-comment"><header><strong>${escape(c.author)}</strong><time>${new Date(c.at).toLocaleString('vi-VN',{timeZone:'Asia/Bangkok'})}</time></header><p>${escape(c.body).replace(/\n/g,'<br>')}</p></article>`).join(''):'<p class="form-caption">Chưa có bình luận.</p>');}catch(error){if($('#comments-list'))$('#comments-list').textContent=error.message;}}
  async function createInvite(){if(!team)return connectModal();if(project()._role!=='owner')throw Error('Chỉ chủ dự án tạo được lời mời.');modal('Mời tham gia dự án',selectField('inviteRole','Quyền của người tham gia','viewer',[['viewer','Chỉ xem'],['commenter','Xem và bình luận'],['editor','Chỉnh sửa và bình luận']])+'<p class="form-caption" style="margin-top:15px">Mỗi liên kết dùng một lần, hiệu lực 48 giờ. Người nhận có thể đăng nhập hoặc tạo tài khoản khi tham gia.</p>',async f=>{const id=project().id,result=await api('/api/projects/'+encodeURIComponent(id)+'/invites','POST',{role:String(f.get('inviteRole'))}),url=new URL('/',location.origin);url.searchParams.set('invite',result.token);latestInvite={projectId:id,url:url.href,expires:result.expires,role:String(f.get('inviteRole'))};page='team';render();},'Tạo liên kết mời');}
  async function openInvitation(){const token=new URLSearchParams(location.search).get('invite');if(!token)return;try{const info=await api('/api/invites/'+encodeURIComponent(token)),me=await api('/api/me');if(me.user){const joined=await api('/api/invites/'+encodeURIComponent(token),'POST',{});history.replaceState(null,'',location.pathname);await loadTeam(joined.user);db.selected=joined.projectId;chooseMode('business');page='team';render();return;}
    modal('Tham gia '+info.name,`<p class="form-caption">Quyền được mời: ${escape(info.role)}. Tạo tài khoản để tham gia, hoặc đăng nhập tài khoản đã có rồi mở lại liên kết này.</p><div class="form-grid">${field('name','Họ tên','','text','maxlength="120"',true)}${field('email','Email','','email','maxlength="160"',true)}${field('password','Mật khẩu','','password','minlength="10" maxlength="128" autocomplete="new-password"',true)}</div><button type="button" class="text-link" data-action="team-connect" style="margin-top:18px">Tôi đã có tài khoản · đăng nhập</button>`,async f=>{const joined=await api('/api/invites/'+encodeURIComponent(token),'POST',{name:String(f.get('name')),email:String(f.get('email')),password:String(f.get('password'))});history.replaceState(null,'',location.pathname);await loadTeam(joined.user);db.selected=joined.projectId;chooseMode('business');page='team';render();},'Tham gia dự án');
  }catch(error){toast(error.message,true);}}

  function guideView() {
    return (
      heading(
        "Hướng dẫn & cơ sở tính",
        "Cơ sở tính, phạm vi bản chạy thử và những hướng phát triển đã nghiên cứu.",
      ) +
      `<div class="guide-grid">${panel("FS / SS / FF / SF", "Ràng buộc tối thiểu; lag có thể âm hoặc dương", `<div class="panel-body"><div class="stat-row"><span>FS · kết thúc → bắt đầu</span><b>Sj ≥ Si + Di + lag</b></div><div class="stat-row"><span>SS · bắt đầu → bắt đầu</span><b>Sj ≥ Si + lag</b></div><div class="stat-row"><span>FF · kết thúc → kết thúc</span><b>Sj ≥ Si + Di − Dj + lag</b></div><div class="stat-row"><span>SF · bắt đầu → kết thúc</span><b>Sj ≥ Si − Dj + lag</b></div><p class="form-caption" style="margin-top:18px">Ví dụ <code>A:FS+2, B:SS-1</code>. “A” đứng riêng mặc định FS+0. SF ít dùng; có thể mô tả một ca trực chỉ kết thúc sau khi ca thay thế bắt đầu. Không tự diễn giải SS/FF thành FS.</p></div>`)}${panel("CPM & lịch làm việc", "Các công việc có thời lượng xác định, không chia đoạn", `<div class="panel-body"><p>ES/EF: bắt đầu/kết thúc sớm. LS/LF: bắt đầu/kết thúc muộn. TF = LS − ES. Công việc găng có TF = 0; quan hệ găng phải chặt và nối hai công việc găng.</p><div class="formula">ESj = max(0, ESi + wij)<br>T = max(ESi + Di)<br>LSi = min(T − Di, LSj − wij)<br>TF = LS − ES</div><p>Toàn bộ công việc dùng một lịch tuần. Mốc 0 là đầu ngày làm việc đầu tiên. Thời lượng, lag và rút ngắn đều là số nguyên ngày làm việc; chưa hỗ trợ giờ, ngày lễ hay lịch riêng từng tổ đội. Không cho quan hệ vòng, kể cả vòng có thể khả thi về mặt đại số.</p></div>`)}${panel("Dự toán & tài chính", "Giả định luôn nằm cạnh thông số nhập", `<div class="panel-body"><p>Dự toán = trực tiếp + chung + khác + dự phòng + thuế. Trực tiếp = Σ khối lượng × (đơn giá vật liệu + nhân công + máy). Dự phòng tính trên trực tiếp + chung + khác; thuế theo tỷ lệ nhập trên tổng trước thuế.</p><div class="formula">NPV = Σ CFt / (1 + r)<sup>t</sup><br>IRR: tìm r để NPV = 0<br>Lãi tháng = dư nợ đầu tháng × lãi năm / 12</div><p>Suất chiết khấu của dòng tiền là lãi hiệu dụng theo năm. Lãi vay nhập là lãi danh nghĩa năm chia 12. Dữ liệu cùng một loại tiền; ứng dụng không tự đổi ngoại tệ. Dự toán hiện là mô hình nội bộ, chưa phải hồ sơ dự toán theo định mức pháp lý.</p></div>`)}${panel("Từ slide đến mô phỏng", "Các tài liệu bạn cung cấp được dùng làm cơ sở chuyên môn", `<div class="panel-body"><ul class="document-list"><li>CI5405 · C2, trang 25: chuẩn bị ngoài trước trong sau; ngầm trước nổi; kết cấu dưới lên, hoàn thiện trên xuống.</li><li>CI5405 · C3, trang 17, 24: trình tự công tác móng và gián đoạn công nghệ. Mẫu 3D thể hiện các giai đoạn tổng quát.</li><li>CI5405 · C4, trang 17–21 và 51–58; CI5407 · C5, trang 17–19, 23–24, 47–50: mạng AON, quan hệ, đường găng và thời gian–chi phí.</li><li>CI5407 · C3: giá trị theo thời gian của tiền; C6: nhu cầu nguồn lực; C7: EVM; C10: nhận dạng và ứng phó rủi ro.</li><li>Dữ liệu QLDA.docx: bài A–G, 25 ngày / trực tiếp 450 USD. Tìm kiếm đầy đủ tái hiện phương án 22 ngày / tổng 775 USD.</li></ul></div>`)}</div>` +
      panel(
        "Chọn các tính năng phục vụ công trình",
        "Đối chiếu thông tin công khai ngày 18/10/2026; chưa trải nghiệm hay kiểm định toàn bộ sản phẩm",
        `<div class="table-scroll"><table class="compare-table"><thead><tr><th>Nguồn tham khảo</th><th>Điểm đáng học</th><th>Áp dụng trong web</th></tr></thead><tbody><tr><td><a href="https://fastdo.vn/phan-mem-quan-ly-du-an-xay-dung/" target="_blank" rel="noreferrer">FastdoWork / bài tổng hợp Fastdo ↗</a></td><td>Kế hoạch, đầu việc, quy trình và phối hợp</td><td>Hai lối vào; công việc rõ người phụ trách, nhìn nhanh tiến độ.</td></tr><tr><td><a href="https://www.oracle.com/construction-engineering/primavera-p6/" target="_blank" rel="noreferrer">Oracle Primavera P6 ↗</a></td><td>CPM, nhiều dự án, nhu cầu nguồn lực, phân tích kịch bản, nối chi phí với tiến độ</td><td>Động cơ ràng buộc, Gantt, AON, biểu đồ nhân công, so sánh phương án.</td></tr><tr><td><a href="https://www.procore.com/financial-management" target="_blank" rel="noreferrer">Procore Financial Management ↗</a></td><td>Ngân sách, dự báo chi phí, thay đổi và thanh toán cùng nguồn dữ liệu</td><td>Gắn BOQ với mã công việc, ngân sách–thực tế, lịch sử. Thanh toán hợp đồng là bước tiếp theo.</td></tr><tr><td><a href="https://amis.misa.vn/amis-cong-viec/" target="_blank" rel="noreferrer">MISA AMIS Công Việc ↗</a></td><td>Phân công, Gantt/Kanban, lịch sử cập nhật và phân quyền theo dự án</td><td>Danh mục, người phụ trách, lịch sử và quyền trên máy chủ. Quy trình phê duyệt nhiều cấp sẽ phát triển tiếp.</td></tr><tr><td><a href="https://gxd.vn/" target="_blank" rel="noreferrer">Hệ phần mềm GXD ↗</a></td><td>Nghiệp vụ riêng cho dự toán, chất lượng, quyết toán, quản lý dự án xây dựng</td><td>Tách công cụ chuyên môn; chuẩn bị cấu trúc để thêm định mức và hồ sơ nghiệm thu sau.</td></tr></tbody></table></div><div class="data-note">Lựa chọn sản phẩm ở đây là đề xuất thiết kế phù hợp yêu cầu của bạn, không phải kết luận web này tốt hơn các phần mềm đã có. Nội dung hướng dẫn soạn lại, không sao chép giao diện hoặc tài sản từ video.</div>`,
      ) +
      panel(
        "Các bước mở rộng cho doanh nghiệp",
        "Phân biệt rõ chức năng đã chạy với phần cần phát triển",
        `<div class="panel-body"><div class="scope-pill">Đã có · CPM & Gantt</div><div class="scope-pill">Đã có · dự toán nội bộ</div><div class="scope-pill">Đã có · mô phỏng 3D khối</div><div class="scope-pill">Đã có · tài chính</div><div class="scope-pill">Đã có · máy chủ chia sẻ và phân quyền</div><p style="margin-top:18px">Các bước tiếp theo: định mức và bộ đơn giá theo địa phương; hợp đồng, phát sinh và phê duyệt; hồ sơ RFI, nhật ký, nghiệm thu; lịch lễ và lịch tổ đội; cân bằng nguồn lực; nhập mô hình IFC/BIM; ứng dụng hiện trường và thông báo; cơ sở dữ liệu PostgreSQL, sao lưu và triển khai HTTPS. Chưa tích hợp AI dự đoán, BIM thật, bộ dữ liệu pháp luật hay nhắc việc tự động trong ứng dụng.</p></div>`,
      )
    );
  }
  function field(
    name,
    label,
    value = "",
    type = "text",
    attributes = "",
    wide = false,
  ) {
    return `<div class="field ${wide ? "wide" : ""}"><label for="f-${name}">${label}</label><input id="f-${name}" name="nen_${name}" type="${type}" value="${escape(value)}" ${attributes} required></div>`;
  }
  function selectField(name, label, value, options, wide = false) {
    return `<div class="field ${wide ? "wide" : ""}"><label for="f-${name}">${label}</label><select id="f-${name}" name="nen_${name}">${options.map(([v, l]) => `<option value="${escape(v)}" ${String(v) === String(value) ? "selected" : ""}>${escape(l)}</option>`).join("")}</select></div>`;
  }
  function textareaField(name, label, value, help = "", wide = true) {
    return `<div class="field ${wide ? "wide" : ""}"><label for="f-${name}">${label}</label><textarea id="f-${name}" name="nen_${name}" rows="3">${escape(value)}</textarea>${help ? `<small>${help}</small>` : ""}</div>`;
  }
  function formValues(form) {
    const result = new FormData();
    for (const [key, value] of new FormData(form))
      result.append(key.startsWith("nen_") ? key.slice(4) : key, value);
    return result;
  }
  const FIELD_LABELS = {
    duration: "Thời lượng", progress: "% hoàn thành", workers: "Nhân công", cost: "Ngân sách trực tiếp",
    actualCost: "Chi phí thực tế", minDuration: "Thời lượng tối thiểu", crashSlope: "Chi phí tăng / ngày rút ngắn",
    stage: "Giai đoạn", pertA: "Ước lượng lạc quan a", pertM: "Ước lượng khả dĩ m", pertB: "Ước lượng bi quan b",
    segment: "Phân đoạn", qty: "Khối lượng", material: "Đơn giá vật liệu", labor: "Đơn giá nhân công",
    machine: "Đơn giá máy", probability: "Xác suất", impact: "Tác động", statusDay: "Ngày báo cáo",
    capacity: "Năng lực nhân công", principal: "Số tiền vay", rate: "Lãi suất", months: "Thời hạn",
    discount: "Suất chiết khấu", overhead: "Chi phí chung", other: "Chi phí khác", contingency: "Dự phòng",
    vat: "Thuế GTGT", profit: "Thu nhập chịu thuế tính trước", indirectBase: "Chi phí gián tiếp", dailySaving: "Giảm gián tiếp/ngày",
  };
  function formNumber(f, k) {
    const value = f.get(k), label = FIELD_LABELS[k] || k;
    if (value === null || !String(value).trim()) throw new Error("Chưa nhập " + label.toLowerCase() + ".");
    const n = Number(value);
    if (!Number.isFinite(n)) throw new Error(label + ": cần nhập số.");
    return n;
  }
  /** "30/04/2027" hoặc "2027-04-30", mỗi dòng/dấu phẩy một ngày → danh sách ISO, đã sắp xếp. */
  function parseHolidayList(text) {
    const days = text.split(/[\n,;]+/).map((s) => s.trim()).filter(Boolean).map((s) => {
      const vn = s.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
      const iso = vn ? vn[3] + "-" + vn[2].padStart(2, "0") + "-" + vn[1].padStart(2, "0") : s;
      CT.parseHolidays([iso]);
      return iso;
    });
    return [...new Set(days)].sort();
  }
  function modal(
    title,
    body,
    handler,
    submit = "Lưu thay đổi ↗",
    kicker = "DỰ ÁN",
  ) {
    $("#modal-title").textContent = title;
    $("#modal-kicker").textContent = kicker;
    $("#modal-body").innerHTML = DOMPurify.sanitize(body);
    $("#modal-submit").textContent = submit;
    $("#modal-error").hidden = true;
    modalHandler = handler;
    if (!$("#modal").open) $("#modal").showModal();
    $(
      "#modal-body input:not([type=checkbox]),#modal-body select,#modal-body textarea",
    )?.focus();
  }
  function validate(p) {
    if (
      !p ||
      typeof p.name !== "string" ||
      !p.name.trim() ||
      p.name.length > 160
    )
      throw new Error("Tên dự án cần từ 1–160 ký tự.");
    if (!["VND", "USD"].includes(p.currency))
      throw new Error("Đơn vị tiền phải là VND hoặc USD.");
    CT.dateAt(p.start, 0, p.workdays, p.holidays);
    CT.number(p.statusDay, "Ngày báo cáo", 0, 100000, true);
    CT.number(p.capacity, "Năng lực nhân công", 0, 100000, true);
    CT.number(p.indirectBase, "Chi phí gián tiếp");
    CT.number(p.dailySaving, "Giảm gián tiếp/ngày");
    GraphBoard.validateLayouts(p.networkLayouts);
    Networks.validateTasks(p.tasks);
    Planner.validate(p);
    const r = Planner.active(p);
    if (r.duration > 100000)
      throw new Error("Tổng tiến độ tối đa 100.000 ngày.");
    p.tasks.forEach((t) => {
      if (t.stage !== undefined) CT.number(t.stage, "Giai đoạn", -1, 6, true);
      if (typeof t.owner !== "string" || t.owner.length > 160)
        throw new Error("Tên người phụ trách không hợp lệ.");
    });
    CT.estimate(p.boq, p.estimate);
    const ids = new Set();
    p.boq.forEach((i) => {
      if (
        !i ||
        !i.id ||
        ids.has(i.id) ||
        typeof i.name !== "string" ||
        !i.name.trim() ||
        typeof i.unit !== "string"
      )
        throw new Error("Dòng dự toán không hợp lệ hoặc trùng mã.");
      ids.add(i.id);
      if (i.task && !p.tasks.some((t) => t.id === i.task))
        throw new Error("Dự toán gắn công việc không tồn tại: " + i.task);
    });
    CT.loan(
      p.finance.principal,
      p.finance.rate,
      p.finance.months,
      p.finance.method,
    );
    CT.appraisal(p.finance.flows, p.finance.discount);
    if (!Array.isArray(p.risks) || p.risks.length > 1000)
      throw new Error("Danh sách rủi ro không hợp lệ.");
    p.risks.forEach((x) => {
      if (
        !x ||
        typeof x.name !== "string" ||
        !x.name.trim() ||
        typeof x.owner !== "string" ||
        typeof x.response !== "string" ||
        !["Đang theo dõi", "Đang xử lý", "Đã đóng"].includes(x.status)
      )
        throw new Error("Rủi ro không hợp lệ.");
      CT.number(x.probability, "Xác suất", 1, 5, true);
      CT.number(x.impact, "Tác động", 1, 5, true);
    });
    if (!Array.isArray(p.history)) p.history = [];
    p.history = p.history
      .slice(0, 100)
      .filter(
        (x) => x && typeof x.text === "string" && typeof x.at === "string",
      );
    if (p.baseline) {
      if (!Array.isArray(p.baseline.rows))
        throw new Error("Kế hoạch gốc không hợp lệ.");
      CT.number(p.baseline.duration, "Thời lượng gốc", 0, 100000, true);
      p.baseline.rows.forEach((x) => {
        CT.number(x.es, "ES gốc", 0, 100000, true);
        CT.number(x.ef, "EF gốc", 0, 100000, true);
      });
    }
    return p;
  }
  async function commit(change, text) {
    const old = project();
    if (team && !["owner","editor"].includes(old._role))
      throw new Error("Bạn không có quyền chỉnh sửa dữ liệu dự án này.");
    const next = copy(old);
    change(next);
    if (next.planning?.selected && Planner.fingerprint(next.tasks) !== Planner.fingerprint(old.tasks)) next.planning.selected = null;
    validate(next);
    next.history.unshift({
      at: new Date().toISOString(),
      text,
      actor: team?.name || "Cá nhân",
    });
    next.history = next.history.slice(0, 100);
    if (team) {
      const result = await api(
        "/api/projects/" + encodeURIComponent(old.id),
        "PUT",
        { project: next, version: old._version },
      );
      next._version = result.version;
    }
    db.projects[db.projects.findIndex((p) => p.id === old.id)] = next;
    optimization = null;
    save();
    render();
    toast(text);
  }
  async function addProject(p) {
    if (db.projects.length >= 100)
      throw new Error("Tối đa 100 dự án trong bản chạy thử.");
    validate(p);
    if (team) {
      const result = await api("/api/projects", "POST", { project: p });
      p._version = result.version;
      p._role = "owner";
    }
    db.projects.push(p);
    db.selected = p.id;
    optimization = null;
    page = "overview";
    save();
    render();
    toast("Đã tạo " + p.name);
  }
  let dependencyTaskId = '';
  function dependencyRow(dep={id:'',type:'FS',lag:0},taskId=dependencyTaskId) {
    const predecessors=project().tasks.filter(t=>t.id!==taskId);
    return `<div class="dependency-row"><label><span>Công việc trước</span><select data-dep-pred required><option value="">Chọn công việc</option>${predecessors.map(t=>`<option value="${escape(t.id)}" ${dep.id===t.id?'selected':''}>${escape(t.id)} · ${escape(t.name)}</option>`).join('')}</select></label><label><span>Loại quan hệ</span><select data-dep-type>${[['FS','FS · Xong → bắt đầu'],['SS','SS · Bắt đầu → bắt đầu'],['FF','FF · Xong → xong'],['SF','SF · Bắt đầu → xong']].map(([v,n])=>`<option value="${v}" ${dep.type===v?'selected':''}>${n}</option>`).join('')}</select></label><label><span>Độ trễ (ngày)</span><div class="dependency-lag"><button type="button" data-dep-lag="-1" aria-label="Giảm độ trễ 1 ngày">−</button><input type="number" data-dep-days value="${dep.lag}" min="-3650" max="3650" step="1" required aria-label="Số ngày trễ hoặc sớm"><button type="button" data-dep-lag="1" aria-label="Tăng độ trễ 1 ngày">+</button></div></label><button type="button" class="dependency-remove" data-dep-remove aria-label="Bỏ liên kết">−</button></div>`;
  }
  function dependencyEditor(t) {
    return `<div class="field wide dependency-editor"><div class="dependency-heading"><label>Quan hệ với công việc trước</label><button type="button" class="btn ghost small" data-action="add-dependency" ${!project().tasks.some(x=>x.id!==t.id)?'disabled':''}>+ Thêm liên kết</button></div><input type="hidden" id="f-deps" name="nen_deps" value="${escape(CT.depText(t.deps))}"><div id="dependency-list">${t.deps.map(dep=>dependencyRow(dep,t.id)).join('')}</div><p id="dependency-empty" class="form-caption" ${t.deps.length?'hidden':''}>Chưa có công việc trước. Công tác có thể bắt đầu độc lập.</p><small>0 = không trễ; số dương = chờ thêm; số âm = cho phép sớm hơn theo quan hệ. Mỗi dòng là một ràng buộc.</small></div>`;
  }
  function syncDependencies() {
    const hidden=$('#f-deps');if(!hidden)return;
    const values=$$('#dependency-list .dependency-row').map(row=>({id:row.querySelector('[data-dep-pred]').value,type:row.querySelector('[data-dep-type]').value,lag:Number(row.querySelector('[data-dep-days]').value)}));
    hidden.value=CT.depText(values.filter(d=>d.id));$('#dependency-empty').hidden=values.length>0;
  }

  function taskModal(id) {
    dependencyTaskId=id||"";
    const p = project(),
      existing = p.tasks.find((t) => t.id === id),
      t = existing || {
        id: "",
        name: "",
        duration: 5,
        deps: [],
        progress: 0,
        cost: 0,
        actualCost: 0,
        workers: 0,
        owner: "",
        minDuration: 5,
        crashSlope: 0,
        stage: -1,
      };
    modal(
      existing ? "Sửa công việc " + t.id : "Thêm công việc",
      `<div class="form-grid">${field("id", "Mã công việc", t.id, "text", `maxlength="24" pattern="[A-Za-z0-9_-]+" ${existing ? "readonly" : ""}`)}${field("duration", "Thời lượng (ngày làm việc)", t.duration, "number", 'min="0" max="3650" step="1"')}${field("name", "Tên công việc", t.name, "text", 'maxlength="200"', true)}${dependencyEditor(t)}<div class="field wide relation-help"><span><b>FS</b>Xong trước → bắt đầu sau</span><span><b>SS</b>Bắt đầu trước → bắt đầu sau</span><span><b>FF</b>Xong trước → xong sau</span><span><b>SF</b>Bắt đầu trước → xong sau</span></div>${field("owner", "Người phụ trách", t.owner, "text", 'maxlength="160"')}${field("progress", "Hoàn thành (%)", t.progress, "number", 'min="0" max="100" step="any"')}${selectField(
        "stage",
        "Giai đoạn trên mô phỏng 3D",
        phaseFor(t),
        [[-1,"Không gắn mô phỏng 3D"],...PHASES.map((name, i) => [i, name])],
        true,
      )}<div class="form-section">NGUỒN LỰC & CHI PHÍ · ${escape(p.currency)}</div>${field("workers", "Nhân công cố định (người/ngày)", t.workers, "number", 'min="0" max="100000" step="1"')}${field("cost", "Ngân sách trực tiếp", t.cost, "number", 'min="0" max="1000000000000000" step="any"')}${field("actualCost", "Chi phí thực tế", t.actualCost, "number", 'min="0" max="1000000000000000" step="any"')}<div></div><div class="form-section">KHẢ NĂNG RÚT NGẮN</div>${field("minDuration", "Thời lượng tối thiểu (ngày)", t.minDuration, "number", 'min="0" max="3650" step="1"')}${field("crashSlope", "Chi phí tăng / ngày rút ngắn", t.crashSlope, "number", 'min="0" max="1000000000000000" step="any"')}</div><details class="task-extra"><summary>PERT · ba ước lượng thời gian</summary><div class="form-grid">${field("pertA","Lạc quan a (ngày)",t.pert?.a??t.duration,"number",'min="0" max="3650" step="any"')}${field("pertM","Khả dĩ nhất m (ngày)",t.pert?.m??t.duration,"number",'min="0" max="3650" step="any"')}${field("pertB","Bi quan b (ngày)",t.pert?.b??t.duration,"number",'min="0" max="3650" step="any"')}</div><small>Cần a ≤ m ≤ b. Thời lượng CPM thường dùng vẫn ở đầu biểu mẫu.</small></details><details class="task-extra"><summary>Sơ đồ xiên · phân đoạn và quá trình</summary><div class="form-grid">${field("segment","Phân đoạn (0 = chưa gắn)",t.segment??0,"number",'min="0" max="100" step="1"')}${field("process","Nhóm quá trình",t.process||"","text",'maxlength="80"')}</div></details>${existing ? `<div class="edit-delete"><span class="form-caption">0 ngày = mốc tiến độ. Lag được phép âm.</span><button type="button" class="btn danger small" data-delete-task="${escape(id)}">Xóa công việc</button></div>` : '<p class="form-caption" style="margin-top:18px">Các công việc phải tạo thành mạng không có vòng lặp. Thời lượng tối thiểu không vượt thời lượng hiện tại.</p>'}`,
      async (f) => {
        await commit(
          (p) => {
            const next = {
              ...t,
              id: String(f.get("id")).trim(),
              name: String(f.get("name")).trim(),
              owner: String(f.get("owner")).trim(),
              deps: CT.parseDeps(String(f.get("deps"))),
              pert:{a:formNumber(f,"pertA"),m:formNumber(f,"pertM"),b:formNumber(f,"pertB")},
              segment:formNumber(f,"segment"),process:String(f.get("process")||"").trim(),
            };
            [
              "duration",
              "progress",
              "workers",
              "cost",
              "actualCost",
              "minDuration",
              "crashSlope",
              "stage",
            ].forEach((k) => (next[k] = formNumber(f, k)));
            // Giảm thời lượng thì thời lượng tối thiểu đi theo, tránh lỗi "tối thiểu > thời lượng" khó hiểu.
            if (next.minDuration > next.duration) next.minDuration = next.duration;
            if(!t.pert&&!$("#f-pertA").closest("details")?.dataset.edited)delete next.pert;
            if (existing) p.tasks[p.tasks.findIndex((x) => x.id === id)] = next;
            else p.tasks.push(next);
          },
          existing
            ? "Đã cập nhật công việc " + id
            : "Đã thêm công việc " + f.get("id"),
        );
      },
    );
    $("#f-owner").required = false;
    $("#f-process").required=false;
  }
  async function deleteProject(){const target=copy(project());if(team&&target._role!=='owner')throw Error('Chỉ chủ dự án được xóa dự án.');modal('Xóa dự án',`<p>Bạn sắp xóa <strong>${escape(target.name)}</strong> với ${target.tasks.length} công tác.</p><p class="form-caption">Dự án sẽ được đưa vào mục đã xóa. Bạn có thể khôi phục lại${team ? " trong 30 ngày" : ""}.</p>`,async()=>{if(team){await api('/api/projects/'+encodeURIComponent(target.id),'DELETE',{version:target._version});await loadTeam(team);}else{db.deletedRecords=[{project:target,deletedAt:Date.now()},...(db.deletedRecords||[])].slice(0,20);db.deletedSamples??=[];if(!db.deletedSamples.includes(target.id))db.deletedSamples.push(target.id);db.projects=db.projects.filter(p=>p.id!==target.id);if(!db.projects.length)db.projects.push(Samples.empty());db.selected=db.projects[0].id;save();}optimization=null;page='overview';history.replaceState(null,'',location.pathname);render();toast('Đã xóa '+target.name+'. Có thể khôi phục trong Dự án đã xóa.');},'Xóa dự án');}
  async function deletedProjectsModal(){const records=team?(await api('/api/deleted-projects')).projects.map(p=>({project:p,deletedAt:p.deletedAt})):(db.deletedRecords||[]);modal('Dự án đã xóa',records.length?records.map(item=>`<div class="member-row"><span>${escape(item.project.name)}</span><button type="button" class="btn ghost small" data-restore-project="${escape(item.project.id)}">Khôi phục</button></div>`).join(''):'<p class="form-caption">Chưa có dự án đã xóa.</p>',()=>{},'Đóng');}
  async function restoreProject(id){if(team){await api('/api/projects/'+encodeURIComponent(id)+'/restore','POST',{});await loadTeam(team);db.selected=id;}else{const entry=db.deletedRecords?.find(e=>e.project.id===id);if(!entry)throw Error('Không tìm thấy dự án đã xóa.');if(db.projects.length>=100)throw Error('Tối đa 100 dự án.');db.projects.push(entry.project);db.selected=id;db.deletedRecords=db.deletedRecords.filter(e=>e.project.id!==id);db.deletedSamples=(db.deletedSamples||[]).filter(x=>x!==id);save();}$('#modal').close();page='overview';render();toast('Đã khôi phục dự án.');}
  function settingsModal() {
    const p = project();
    modal(
      "Cài đặt dự án",
      `<div class="form-grid">${field("name", "Tên dự án", p.name, "text", 'maxlength="160"', true)}${field("start", "Ngày khởi công", p.start, "date", 'min="1900-01-01" max="2200-12-31"')}${selectField(
        "currency",
        "Đơn vị tiền",
        p.currency,
        [
          ["VND", "VND · Việt Nam đồng"],
          ["USD", "USD · Đô la Mỹ"],
        ],
      )}<div class="field wide"><label>Ngày làm việc trong tuần</label><div class="weekday-group">${[
        [1, "T2"],
        [2, "T3"],
        [3, "T4"],
        [4, "T5"],
        [5, "T6"],
        [6, "T7"],
        [0, "CN"],
      ]
        .map(
          ([v, l]) =>
            `<label><input type="checkbox" name="workdays" value="${v}" ${p.workdays.includes(v) ? "checked" : ""}>${l}</label>`,
        )
        .join(
          "",
        )}</div><small>Nếu ngày khởi công rơi vào ngày nghỉ, mốc 0 chuyển đến ngày làm việc tiếp theo.</small></div>${textareaField("holidays", "Ngày nghỉ lễ (mỗi dòng một ngày, dd/mm/yyyy)", (p.holidays || []).map(dateLabel).join("\n"), "Ví dụ 01/01/2027, 30/04/2027, 01/05/2027, 02/09/2027 và các ngày Tết theo lịch thực tế. Ngày lễ không tính là ngày làm việc.")}${field("statusDay", "Báo cáo tại cuối ngày thứ", p.statusDay, "number", 'min="0" max="100000" step="1"')}${field("capacity", "Năng lực nhân công (người/ngày)", p.capacity, "number", 'min="0" max="100000" step="1"')}</div><p class="form-caption" style="margin-top:20px">Đổi loại tiền chỉ thay đơn vị hiển thị, không tự quy đổi các số tiền. Hãy nhập lại đơn giá và các giá trị nếu cần.</p><div class="edit-delete"><button type="button" class="btn ghost small" data-action="deleted-projects">Dự án đã xóa</button><button type="button" class="btn danger small" data-action="delete-project" ${team&&p._role!=="owner"?"disabled":""}>Xóa dự án</button></div>`,
      (f) =>
        commit((p) => {
          p.name = String(f.get("name")).trim();
          p.start = String(f.get("start"));
          p.currency = String(f.get("currency"));
          p.workdays = f.getAll("workdays").map(Number);
          p.holidays = parseHolidayList(String(f.get("holidays") || ""));
          p.statusDay = formNumber(f, "statusDay");
          p.capacity = formNumber(f, "capacity");
          if (p.planning) p.planning.capacity = p.capacity;
        }, "Đã lưu cài đặt dự án"),
    );
  }
  function boqModal(id) {
    const p = project(),
      existing = p.boq.find((i) => i.id === id),
      i = existing || {
        id: uid(),
        name: "",
        task: "",
        unit: "m³",
        qty: 1,
        material: 0,
        labor: 0,
        machine: 0,
      };
    modal(
      existing ? "Sửa công tác dự toán" : "Thêm công tác dự toán",
      `<div class="form-grid">${field("name", "Tên công tác", i.name, "text", 'maxlength="200"', true)}${selectField("task", "Gắn với công việc", i.task, [["", "Chưa gắn"], ...p.tasks.map((t) => [t.id, t.id + " · " + t.name])])}${field("unit", "Đơn vị tính", i.unit, "text", 'maxlength="20"')}${field("qty", "Khối lượng", i.qty, "number", 'min="0" max="1000000000000" step="any"')}${field("material", "Đơn giá vật liệu / đơn vị", i.material, "number", 'min="0" max="1000000000000" step="any"')}${field("labor", "Đơn giá nhân công / đơn vị", i.labor, "number", 'min="0" max="1000000000000" step="any"')}${field("machine", "Đơn giá máy / đơn vị", i.machine, "number", 'min="0" max="1000000000000" step="any"')}</div>${existing ? `<div class="edit-delete"><span class="currency-label">${escape(p.currency)}</span><button type="button" class="btn danger small" data-delete-boq="${escape(id)}">Xóa công tác</button></div>` : ""}`,
      (f) =>
        commit((p) => {
          const next = {
            ...i,
            name: String(f.get("name")).trim(),
            unit: String(f.get("unit")).trim(),
            task: String(f.get("task")),
          };
          ["qty", "material", "labor", "machine"].forEach(
            (k) => (next[k] = formNumber(f, k)),
          );
          if (existing) p.boq[p.boq.findIndex((x) => x.id === id)] = next;
          else p.boq.push(next);
        }, "Đã lưu công tác dự toán"),
    );
  }
  function riskModal(id) {
    const old = project().risks.find((x) => x.id === id),
      x = old || {
        id: uid(),
        name: "",
        probability: 3,
        impact: 3,
        owner: "",
        response: "",
        status: "Đang theo dõi",
      };
    modal(
      old ? "Cập nhật rủi ro" : "Thêm rủi ro",
      `<div class="form-grid">${field("name", "Mô tả rủi ro", x.name, "text", 'maxlength="300"', true)}${selectField(
        "probability",
        "Xác suất (1 thấp → 5 cao)",
        x.probability,
        [1, 2, 3, 4, 5].map((i) => [i, String(i)]),
      )}${selectField(
        "impact",
        "Tác động (1 thấp → 5 cao)",
        x.impact,
        [1, 2, 3, 4, 5].map((i) => [i, String(i)]),
      )}${field("owner", "Người phụ trách", x.owner, "text", 'maxlength="160"')}${selectField(
        "status",
        "Trạng thái",
        x.status,
        ["Đang theo dõi", "Đang xử lý", "Đã đóng"].map((i) => [i, i]),
      )}${textareaField("response", "Phương án ứng phó", x.response)}</div>${old ? `<div class="edit-delete"><span></span><button type="button" class="btn danger small" data-delete-risk="${escape(id)}">Xóa rủi ro</button></div>` : ""}`,
      (f) =>
        commit((p) => {
          const next = {
            ...x,
            name: String(f.get("name")).trim(),
            owner: String(f.get("owner")).trim(),
            response: String(f.get("response")).trim(),
            probability: formNumber(f, "probability"),
            impact: formNumber(f, "impact"),
            status: String(f.get("status")),
          };
          if (old) p.risks[p.risks.findIndex((r) => r.id === id)] = next;
          else p.risks.push(next);
        }, "Đã cập nhật sổ rủi ro"),
    );
    $("#f-owner").required = false;
  }
  function download(name, text, type = "application/json") {
    const url = URL.createObjectURL(new Blob([text], { type })),
      a = document.createElement("a");
    a.href = url;
    a.download = name;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function exportCSV(name, headers, rows) {
    const cell = (v) => {
      let text = String(v ?? "");
      if (/^[=+\-@\t\r]/.test(text) && typeof v !== "number") text = "'" + text;
      return '"' + text.replace(/"/g, '""') + '"';
    };
    download(
      name,
      "\uFEFF" +
        [headers, ...rows].map((r) => r.map(cell).join(",")).join("\r\n"),
      "text/csv;charset=utf-8",
    );
  }
  async function api(path, method = "GET", body) {
    const r = await fetch(path, {
      method,
      headers: body ? { "Content-Type": "application/json" } : {},
      credentials: "same-origin",
      body: body ? JSON.stringify(body) : undefined,
    });
    let data;
    try {
      data = await r.json();
    } catch {
      throw new Error(
        "Không kết nối được máy chủ ứng dụng. Hãy chạy npm start.",
      );
    }
    if (!r.ok) throw new Error(data.error || "Yêu cầu thất bại.");
    return data;
  }
  async function loadTeam(user) {
    team = user;
    graphDrafts.clear();
    const invitation=new URLSearchParams(location.search).get('invite');let joinedId;
    if(invitation){try{const joined=await api('/api/invites/'+encodeURIComponent(invitation),'POST',{});joinedId=joined.projectId;history.replaceState(null,'',location.pathname);}catch(error){toast(error.message,true);}}
    const projects = await api("/api/projects");
    db = {
      schema: 1,
      projects: projects.projects,
      selected: joinedId || projects.projects[0]?.id,
    };
    if (!db.projects.length) {
      const p = Samples.construction(),
        r = await api("/api/projects", "POST", { project: p });
      p._version = r.version;
      p._role = "owner";
      db.projects = [p];
      db.selected = p.id;
    }
    optimization = null;
    page = mode === "business" ? "portfolio" : "overview";
    render();
  }
  async function connectModal() {
    if (team) {
      modal(
        "Không gian chung",
        `<p class="form-caption">Đang đăng nhập <strong>${escape(team.name)}</strong> · ${escape(team.email)}.</p><div class="heading-actions" style="justify-content:flex-start;margin-top:20px"><button type="button" class="btn ghost" data-action="refresh-server">↻ Tải lại dự án</button><button type="button" class="btn danger" data-action="logout">Đăng xuất</button></div>`,
        () => {},
        "Đóng",
        "TÀI KHOẢN",
      );
      return;
    }
    if (!serverAvailable) {
      modal(
        "Kết nối đội dự án",
        `<p class="form-caption">Chế độ cá nhân hoạt động ngay khi mở file. Để nhiều tài khoản dùng chung, mở Terminal tại thư mục dự án rồi chạy:</p><div class="formula">npm start</div><p class="form-caption">Mở địa chỉ được in trong Terminal. Máy chủ đi kèm dùng Node.js 22.13+ và SQLite, lưu dữ liệu trong thư mục <code>data/</code>. Bạn có thể tiếp tục dùng cục bộ và xuất/nhập JSON.</p>`,
        () => {},
        "Tiếp tục dùng cục bộ",
        "KHÔNG GIAN CHUNG",
      );
      return;
    }
    const me = await api("/api/me");
    if (me.user) {
      await loadTeam(me.user);
      toast("Đã kết nối không gian chung");
      return;
    }
    const setup = me.setup;
    modal(
      setup ? "Tạo tài khoản quản trị" : "Đăng nhập không gian chung",
      `<div class="team-login">${setup && me.setupTokenRequired ? field("setupToken", "Mã thiết lập (in trong cửa sổ Terminal của máy chủ)", "", "text", 'maxlength="200" autocomplete="off"') : ""}${setup ? field("name", "Họ tên", "", "text", 'maxlength="120"') : ""}${field("email", "Email", "", "email", 'maxlength="160" autocomplete="username"')}${field("password", "Mật khẩu", "", "password", 'minlength="10" maxlength="128" autocomplete="' + (setup ? "new-password" : "current-password") + '"')}<p class="form-caption">${setup ? "Tài khoản đầu tiên quản trị không gian. Sau đó quản trị có thể tạo tài khoản cho thành viên trong mục quyền dự án." : "Tài khoản được quản trị tạo trong không gian chung. Tối thiểu 10 ký tự cho mật khẩu."}</p></div>`,
      async (f) => {
        const response = await api(
          setup ? "/api/setup" : "/api/login",
          "POST",
          Object.fromEntries(f),
        );
        await loadTeam(response.user);
        toast("Đã đăng nhập không gian chung");
      },
      setup ? "Tạo tài khoản & vào dự án ↗" : "Đăng nhập ↗",
      "TÀI KHOẢN",
    );
  }
  async function membersModal() {
    if (!team) return connectModal();
    const p = project(),
      data = await api(
        "/api/projects/" + encodeURIComponent(p.id) + "/members",
      ),
      users = await api("/api/users"),
      invites = p._role === "owner" ? (await api("/api/projects/" + encodeURIComponent(p.id) + "/invites").catch(() => ({ invites: [] }))).invites : [];
    const roleName = { owner: "Chủ dự án", editor: "Chỉnh sửa", commenter: "Bình luận", viewer: "Chỉ xem" };
    modal(
      "Quyền truy cập dự án",
      `<div>${data.members.map((m) => `<div class="member-row"><span>${escape(m.name)}<small class="muted" style="margin-left:8px">${escape(m.email)}</small></span><span><span class="badge">${escape(roleName[m.role] || m.role)}</span>${p._role === "owner" || m.id === team.id ? ` <button type="button" class="btn ghost small" data-remove-member="${m.id}">${m.id === team.id ? "Rời dự án" : "Gỡ"}</button>` : ""}</span></div>`).join("")}</div>${invites.length ? `<h3 style="margin:20px 0 8px">Lời mời chưa dùng</h3>${invites.map((i) => `<div class="member-row"><span>${escape(roleName[i.role] || i.role)} · tạo bởi ${escape(i.creator)}<small class="muted" style="margin-left:8px">hết hạn ${new Date(i.expires).toLocaleString("vi-VN", { timeZone: "Asia/Bangkok" })}</small></span><button type="button" class="btn ghost small" data-revoke-invite="${escape(i.id)}">Thu hồi</button></div>`).join("")}` : ""}<p class="team-roles" style="margin:15px 0 25px">owner: quản lý quyền · editor: sửa và bình luận · commenter: xem và bình luận · viewer: chỉ đọc. Gán lại vai trò để thay quyền. Chủ dự án gốc luôn giữ quyền owner.</p><div class="form-grid">${selectField(
        "userId",
        "Tài khoản",
        users.users[0]?.id,
        users.users.map((u) => [u.id, u.name + " · " + u.email]),
        true,
      )}${selectField("role", "Vai trò", "viewer", [
        ["viewer", "viewer · chỉ xem"],
        ["editor", "editor · chỉnh sửa"],
        ["commenter", "commenter · xem và bình luận"],
        ["owner", "owner · quản lý quyền"],
      ])}</div>${team.admin ? '<div class="edit-delete"><span class="form-caption">Chưa có tài khoản cho thành viên?</span><button type="button" class="btn ghost small" data-action="create-user">+ Tạo tài khoản</button></div>' : ""}`,
      async (f) => {
        await api(
          "/api/projects/" + encodeURIComponent(p.id) + "/members",
          "POST",
          { userId: Number(f.get("userId")), role: String(f.get("role")) },
        );
        toast("Đã cập nhật quyền truy cập");
      },
      "Lưu quyền truy cập ↗",
      "ĐỘI DỰ ÁN",
    );
  }
  const actions = {
    "delete-project":deleteProject,
    "deleted-projects":deletedProjectsModal,
    "graph-save":()=>{const d=activeGraphDraft(),kind=networkType==='aoa'?'aoa':'aon';return commit(p=>{p.networkLayouts??={};p.networkLayouts[kind]=copy(d.positions);d.dirty=false;},'Đã lưu bố trí sơ đồ');},
    "graph-auto":()=>{const d=activeGraphDraft();d.positions=GraphBoard.positions(d.graph);d.dirty=true;render();},
    "graph-fit":()=>{const d=activeGraphDraft(),width=GraphBoard.bounds(d.graph,d.positions).width;d.zoom=Math.max(.2,Math.min(1,$('#network-svg').clientWidth/width));mountGraphEditor();},
    "show-aon":()=>{networkType="aon";render();},
    "print-select-all":()=>{printItems.forEach(([id])=>printSelected.add(id));render();},
    "print-clear":()=>{printSelected.clear();render();},
    "copy-current":()=>exportPages('clipboard',true),
    "export-current":exportCurrentModal,
    "refresh-comments":loadComments,
    "create-invite":createInvite,
    "copy-invite":async()=>{await navigator.clipboard.writeText(latestInvite.url);toast('Đã sao chép liên kết mời.');},
    "add-dependency": () => {const t=project().tasks.find(x=>x.id!==dependencyTaskId);if(!t)return;$('#dependency-list').insertAdjacentHTML('beforeend',DOMPurify.sanitize(dependencyRow({id:t.id,type:'FS',lag:0})));syncDependencies();},
    "run-planning": runPlanning,
    "apply-planning": applyPlanning,
    "planning-csv": () => exportPlanning(false),
    "planning-report": () => exportPlanning(true),
    "clear-planning": () => commit(p=>{if(p.planning)p.planning.selected=null;},"Đã trở về lịch CPM sớm nhất"),
    "manual-earliest": () => {const d=readPlanningForm();d.manual=Object.fromEntries(CT.schedule(project().tasks).rows.map(t=>[t.id,t.es]));d.report=null;render();},
    "cancel-planning": () => {planningRun++;planningWorker?.terminate();planningWorker=null;const d=planningDraft();d.busy=false;d.error='Đã dừng tìm kiếm.';render();},
    "pause-motion": () => {
      BuildScene.paused = !BuildScene.paused;
      BuildScene.heldTime = performance.now();
      $$("[data-action=pause-motion]").forEach((b) => {
        b.textContent = BuildScene.paused
          ? "Bật chuyển động"
          : "Dừng chuyển động";
        b.setAttribute("aria-pressed", String(BuildScene.paused));
      });
    },
    home: () => transitionView(home),
    "scroll-modes": () => $("#modes").scrollIntoView({ behavior: "smooth" }),
    "close-modal": () => $("#modal").close(),
    settings: settingsModal,
    "add-task": () => taskModal(),
    "add-boq": () => boqModal(),
    "add-risk": () => riskModal(),
    "new-project": () =>
      modal(
        "Tạo dự án mới",
        `<div class="form-grid">${field("name", "Tên dự án", "", "text", 'maxlength="160"', true)}${selectField(
          "currency",
          "Đơn vị tiền",
          "VND",
          [
            ["VND", "VND"],
            ["USD", "USD"],
          ],
        )}${field("start", "Ngày khởi công", new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10), "date", 'min="1900-01-01" max="2200-12-31"')}</div>`,
        async (f) => {
          const p = Samples.empty();
          p.name = String(f.get("name")).trim();
          p.start = String(f.get("start"));
          p.currency = String(f.get("currency"));
          if (p.currency === "USD") {
            // Mặc định tài chính của mẫu tính theo VND; đổi về quy mô USD để không ra "500.000.000 USD".
            p.finance = { ...p.finance, principal: 20000, flows: [-40000, 14000, 16000, 18000] };
          }
          await addProject(p);
        },
        "Tạo dự án ↗",
      ),
    "sample-textbook": () => addProject(Samples.textbook()),
    "sample-construction": () => addProject(Samples.construction()),
    export: () => {
      const p = copy(project());
      delete p._version;
      delete p._role;
      download(
        "nen-du-an.json",
        JSON.stringify({ schema: 1, project: p }, null, 2),
      );
      toast("Đã xuất bản sao dữ liệu dự án");
    },
    import: () => $("#import-file").click(),
    csv: () => {
      const r = calc();
      exportCSV(
        "nen-tien-do.csv",
        [
          "Mã",
          "Công việc",
          "Thời lượng (ngày)",
          "Quan hệ trước",
          "Phụ trách",
          "Ngân sách " + project().currency,
          "Thực tế " + project().currency,
          "Hoàn thành %",
          "Nhân công (người/ngày)",
          "ES",
          "EF",
          "LS",
          "LF",
          "TF",
          "Dự trữ riêng",
          "Găng",
          "Ngày bắt đầu",
          "Ngày kết thúc",
        ],
        r.rows.map((t) => [
          t.id,
          t.name,
          t.duration,
          CT.depText(t.deps),
          t.owner,
          t.cost,
          t.actualCost,
          t.progress,
          t.workers,
          t.es,
          t.ef,
          t.ls,
          t.lf,
          t.tf,
          t.ff,
          t.critical ? "Có" : "Không",
          dateLabel(workDate(project(), t.es)),
          dateLabel(workDate(project(), Math.max(t.es, t.ef - 1))),
        ]),
      );
    },
    "boq-csv": () =>
      exportCSV(
        "nen-du-toan.csv",
        [
          "Công tác",
          "Mã công việc",
          "Đơn vị",
          "Khối lượng",
          "Đơn giá vật liệu",
          "Đơn giá nhân công",
          "Đơn giá máy",
          "Thành tiền " + project().currency,
        ],
        CT.estimate(project().boq, project().estimate).lines.map((i) => [
          i.name,
          i.task,
          i.unit,
          i.qty,
          i.material,
          i.labor,
          i.machine,
          i.total,
        ]),
      ),
    "loan-csv": () => {
      const f = project().finance;
      exportCSV(
        "nen-lich-tra-no.csv",
        ["Tháng", "Gốc trả", "Lãi trả", "Tổng trả", "Dư nợ cuối kỳ"],
        CT.loan(f.principal, f.rate, f.months, f.method).rows.map((x) => {
          // Làm tròn theo đơn vị tiền để bảng tính không hiện số lẻ dài.
          const digits = project().currency === "USD" ? 2 : 0, round = (v) => Number(v.toFixed(digits));
          return [x.month, round(x.capital), round(x.interest), round(x.payment), round(x.balance)];
        }),
      );
    },
    "network-svg": () => {
      const e = $("#network-svg svg");
      if (e) {
        const svg = e.cloneNode(true);
        svg.setAttribute("xmlns", "http://www.w3.org/2000/svg");
        download("nen-so-do-mang.svg", svg.outerHTML, "image/svg+xml");
      }
    },
    baseline: () =>
      modal(
        "Chốt kế hoạch gốc",
        `<p class="form-caption">Lưu tiến độ hiện tại ${calc().duration} ngày để so sánh về sau. ${project().baseline ? "Thao tác này thay thế bản kế hoạch gốc đang lưu." : "Các thanh mảnh bên dưới Gantt sẽ thể hiện kế hoạch gốc."}</p>`,
        () =>
          commit((p) => {
            const r = Planner.active(p);
            p.baseline = {
              at: new Date().toISOString(),
              duration: r.duration,
              rows: r.rows.map((t) => ({ id: t.id, es: t.es, ef: t.ef })),
            };
          }, "Đã chốt kế hoạch gốc"),
        "Chốt kế hoạch gốc ↗",
      ),
    "estimate-settings": () => {
      const e = project().estimate;
      modal(
        "Tỷ lệ & chi phí dự toán",
        `<div class="form-grid">${field("overhead", "Chi phí chung (% trực tiếp)", e.overhead, "number", 'min="0" max="100" step="any"')}${field("other", "Chi phí khác", e.other, "number", 'min="0" max="1000000000000000" step="any"')}${field("contingency", "Dự phòng (%)", e.contingency, "number", 'min="0" max="100" step="any"')}${field("profit", "Thu nhập chịu thuế tính trước (% × (T + C))", e.profit ?? 0, "number", 'min="0" max="100" step="any"')}${field("vat", "Thuế GTGT (%)", e.vat, "number", 'min="0" max="100" step="any"')}</div><p class="form-caption" style="margin-top:18px">T trực tiếp → C = T × % chung → TL = (T + C) × % → dự phòng tính trên T + C + TL + khác → thuế GTGT trên giá trước thuế (gồm dự phòng). Tỷ lệ do bạn nhập theo hồ sơ dự án; ứng dụng không tự chọn mức theo văn bản pháp luật.</p>`,
        (f) =>
          commit(
            (p) =>
              ["overhead", "other", "contingency", "vat", "profit"].forEach(
                (k) => (p.estimate[k] = formNumber(f, k)),
              ),
            "Đã cập nhật tỷ lệ dự toán",
          ),
      );
    },
    "sync-boq": () => {
      const p = project(),
        lines = CT.estimate(p.boq, p.estimate).lines,
        linked = lines.filter((i) => i.task),
        ids = [...new Set(linked.map((i) => i.task))];
      if (!ids.length)
        return toast("Chưa có dòng dự toán gắn mã công việc.", true);
      modal(
        "Cập nhật ngân sách từ dự toán",
        `<p class="form-caption">Thay ngân sách trực tiếp của ${ids.map(escape).join(", ")} bằng tổng dòng dự toán tương ứng (${money(linked.reduce((s, i) => s + i.total, 0))}). Ngân sách công việc không có dòng dự toán sẽ được giữ nguyên.</p>`,
        () =>
          commit((p) => {
            ids.forEach(
              (id) =>
                (p.tasks.find((t) => t.id === id).cost = linked
                  .filter((i) => i.task === id)
                  .reduce((s, i) => s + i.total, 0)),
            );
          }, "Đã đồng bộ ngân sách công việc từ dự toán"),
        "Cập nhật ngân sách ↗",
      );
    },
    "cost-settings": () => {
      const p = project();
      modal(
        "Chi phí gián tiếp của phương án gốc",
        `<div class="form-grid">${field("indirectBase", "Gián tiếp tại thời lượng hiện tại", p.indirectBase, "number", 'min="0" max="1000000000000000" step="any"', true)}${field("dailySaving", "Giảm gián tiếp / ngày rút ngắn", p.dailySaving, "number", 'min="0" max="1000000000000000" step="any"', true)}</div><p class="form-caption" style="margin-top:18px">Gián tiếp phương án = max(0, gián tiếp gốc − số ngày rút ngắn × mức giảm/ngày). Chi phí khác như vay vốn không tự cộng vào đây.</p>`,
        (f) =>
          commit((p) => {
            p.indirectBase = formNumber(f, "indirectBase");
            p.dailySaving = formNumber(f, "dailySaving");
          }, "Đã cập nhật chi phí gián tiếp"),
      );
    },
    optimize: async () => {
      if (!project().tasks.length)
        return toast("Thêm công việc trước khi phân tích.", true);
      const b = $("#optimize-btn");
      if (b) {
        b.disabled = true;
        b.textContent = "Đang so sánh phương án…";
      }
      await new Promise((resolve) => setTimeout(resolve, 60));
      try {
        optimization = CT.optimize(
          project().tasks,
          project().indirectBase,
          project().dailySaving,
        );
        page = "costs";
        render();
        toast("Đã so sánh " + fmt(optimization.combinations) + " tổ hợp");
      } catch (e) {
        if (b) {
          b.disabled = false;
          b.textContent = "Phân tích rút ngắn ↗";
        }
        throw e;
      }
    },
    "play-scene": () => {
      if (sceneTimer) {
        clearInterval(sceneTimer);
        sceneTimer = null;
        $("#play-scene").textContent = "▶ Chạy";
        return;
      }
      window.resumeProjectScene?.();
      window.updateProjectScene?.();
      const duration = calc().duration;
      if (!duration) return;
      if (sceneDay >= duration) sceneDay = 0;
      $("#play-scene").textContent = "Ⅱ Dừng";
      sceneTimer = setInterval(() => {
        sceneDay = Math.min(duration, sceneDay + 1);
        $("#scene-slider").value = sceneDay;
        window.updateProjectScene?.();
        if (sceneDay === duration) {
          clearInterval(sceneTimer);
          sceneTimer = null;
          $("#play-scene").textContent = "↻ Chạy lại";
        }
      }, 500);
    },
    "team-connect": connectModal,
    members: membersModal,
    "refresh-server": async () => {
      await loadTeam(team);
      $("#modal").close();
      toast("Đã tải phiên bản mới nhất từ máy chủ");
    },
    logout: async () => {
      await api("/api/logout", "POST", {});
      team = null;
      try {
        db = loadWorkspace(localStorage.getItem(KEY));
      } catch {
        db = null;
      }
      if (!db?.projects?.length) {
        const p = Samples.construction();
        db = { schema: 1, projects: [p], selected: p.id };
      }
      $("#modal").close();
      page = mode === "business" ? "portfolio" : "overview";
      render();
      toast("Đã trở về dữ liệu cục bộ");
    },
    "create-user": () =>
      modal(
        "Tạo tài khoản thành viên",
        `<div class="form-grid">${field("name", "Họ tên", "", "text", 'maxlength="120"', true)}${field("email", "Email", "", "email", 'maxlength="160"', true)}${field("password", "Mật khẩu ban đầu", "", "password", 'minlength="10" maxlength="128" autocomplete="new-password"', true)}</div><p class="form-caption" style="margin-top:16px">Tạo xong, vào Quyền truy cập dự án để gán tài khoản vào dự án. Chỉ quản trị không gian có thể tạo tài khoản.</p>`,
        async (f) => {
          await api("/api/users", "POST", Object.fromEntries(f));
          toast("Đã tạo tài khoản thành viên");
        },
        "Tạo tài khoản ↗",
        "QUẢN TRỊ",
      ),
  };
  document.addEventListener("click", async (event) => {
    const e = event.target.closest(
      "button,[data-edit-task],[data-edit-boq],[data-edit-risk]",
    );
    if (!e) return;
    try {
      if(e.hasAttribute('data-dep-remove')){e.closest('.dependency-row').remove();syncDependencies();return;}
      if(e.dataset.depLag){const input=e.closest('.dependency-lag').querySelector('input');input.value=Math.max(-3650,Math.min(3650,Number(input.value)+Number(e.dataset.depLag)));syncDependencies();return;}
      if(e.dataset.graphZoom){const d=activeGraphDraft();d.zoom=Math.max(.2,Math.min(3,d.zoom*Number(e.dataset.graphZoom)));const svg=$('#network-svg svg'),bounds=GraphBoard.bounds(d.graph,d.positions);svg.style.width=bounds.width*d.zoom+'px';svg.style.height=bounds.height*d.zoom+'px';return;}
      if(e.dataset.exportFormat){await exportPages(e.dataset.exportFormat);return;}
      if(e.dataset.restoreProject){await restoreProject(e.dataset.restoreProject);return;}
      if(e.dataset.removeMember){await api("/api/projects/"+encodeURIComponent(project().id)+"/members/"+encodeURIComponent(e.dataset.removeMember),"DELETE");toast("Đã gỡ thành viên khỏi dự án.");if(Number(e.dataset.removeMember)===team?.id){$("#modal").close();await loadTeam(team);}else await membersModal();return;}
      if(e.dataset.revokeInvite){await api("/api/projects/"+encodeURIComponent(project().id)+"/invites/"+encodeURIComponent(e.dataset.revokeInvite),"DELETE");toast("Đã thu hồi lời mời.");await membersModal();return;}
      if (e.dataset.mode)
        return transitionView(() => chooseMode(e.dataset.mode));
      if (e.dataset.detailMode !== undefined) {
        window.showConstructionDetail?.(e.dataset.detailMode);
        return;
      }
      if (e.dataset.seekPhase !== undefined) {
        window.seekProjectPhase?.(
          Number(e.dataset.seekPhase),
          e.dataset.seekEnd === "true",
        );
        return;
      }
      if (e.dataset.earthworkProgress !== undefined) {
        window.previewEarthwork?.(e.dataset.earthworkProgress); return;
      }
      if(e.dataset.processShift){const scope=e.dataset.processTarget,select=$('[data-process-select="'+scope+'"]'),current=select.value==='plan'?-1:Number(select.value),index=Math.max(0,current+Number(e.dataset.processShift));if(scope==='hero')seekHeroStep(index);else window.seekConstructionStep?.(index);return;}
      if (e.dataset.heroProgress !== undefined) {
        heroProgress = Number(e.dataset.heroProgress);
        $("#hero-slider").value = heroProgress * 100;
        $("#hero-stage").textContent = e.dataset.heroLabel || PHASES[BuildScene.phaseAt(heroProgress)]; return;
      }
      if (e.dataset.heroStage !== undefined) {
        heroProgress = BuildScene.phaseMiddle(Number(e.dataset.heroStage));
        $("#hero-slider").value = heroProgress * 100;
        $("#hero-stage").textContent = PHASES[BuildScene.phaseAt(heroProgress)];
        return;
      }

      if (e.dataset.page) {
        transitionView(() => {
          page = e.dataset.page;
          optimization = page === "costs" ? optimization : null;
          render();
          $(".sidebar").classList.remove("open");
          syncSidebar();
          window.scrollTo(0, 0);
        });
        return;
      }
      if (e.dataset.openProject) {
        db.selected = e.dataset.openProject;
        page = "overview";
        optimization = null;
        save();
        render();
        return;
      }
      if (e.dataset.planPreview !== undefined) {readPlanningForm().preview=Number(e.dataset.planPreview);render();return;}
      if (e.dataset.manualShift) {
        const d=readPlanningForm(),id=e.dataset.manualShift;
        d.manual[id]=Math.max(0,(d.manual[id]||0)+Number(e.dataset.delta));
        const input=$$('[data-manual-start]').find(i=>i.dataset.manualStart===id);if(input)input.value=d.manual[id];return;
      }
      if (e.dataset.scheduleTab) {
        page = "schedule";
        scheduleTab = e.dataset.scheduleTab;
        render();
        return;
      }
      if (e.dataset.editTask !== undefined)
        return taskModal(e.dataset.editTask);
      if (e.dataset.editBoq) return boqModal(e.dataset.editBoq);
      if (e.dataset.editRisk) return riskModal(e.dataset.editRisk);
      if (e.dataset.deleteTask) {
        const id = e.dataset.deleteTask,
          p = project(),
          succ = p.tasks
            .filter((t) => t.deps.some((d) => d.id === id))
            .map((t) => t.id),
          b = p.boq.filter((i) => i.task === id).length;
        return modal(
          "Xóa công việc " + id,
          `<p class="form-caption">Công việc sẽ bị xóa.${succ.length ? " Các quan hệ phụ thuộc trong " + succ.map(escape).join(", ") + " sẽ được gỡ." : ""}${b ? " " + b + " dòng dự toán sẽ bỏ gắn mã công việc." : ""} Tiến độ sẽ được tính lại.</p>`,
          () =>
            commit((p) => {
              p.tasks = p.tasks.filter((t) => t.id !== id);
              p.tasks.forEach(
                (t) => (t.deps = t.deps.filter((d) => d.id !== id)),
              );
              p.boq.forEach((i) => {
                if (i.task === id) i.task = "";
              });
            }, "Đã xóa công việc " + id),
          "Xác nhận xóa",
        );
      }
      if (e.dataset.deleteBoq) {
        const id = e.dataset.deleteBoq;
        return modal(
          "Xóa dòng dự toán",
          '<p class="form-caption">Dòng này sẽ bị xóa khỏi dự toán. Ngân sách công việc đã đồng bộ trước đó không tự thay đổi.</p>',
          () =>
            commit(
              (p) => (p.boq = p.boq.filter((i) => i.id !== id)),
              "Đã xóa công tác dự toán",
            ),
          "Xác nhận xóa",
        );
      }
      if (e.dataset.deleteRisk) {
        const id = e.dataset.deleteRisk;
        return modal(
          "Xóa rủi ro",
          '<p class="form-caption">Xóa rủi ro khỏi sổ dự án. Bạn có thể chọn trạng thái Đã đóng để giữ lịch sử thay vì xóa.</p>',
          () =>
            commit(
              (p) => (p.risks = p.risks.filter((i) => i.id !== id)),
              "Đã xóa rủi ro",
            ),
          "Xác nhận xóa",
        );
      }
      if (e.dataset.applyScenario) {
        const s = optimization?.scenarios.find(
          (s) => s.duration === Number(e.dataset.applyScenario),
        );
        if (!s) return;
        return modal(
          "Áp dụng phương án " + s.duration + " ngày",
          `<p class="form-caption">Rút ngắn ${s.reductions.map((x) => escape(x.id) + " −" + x.days + " ngày").join(", ") || "0 ngày"}. Cập nhật chi phí trực tiếp thành ${money(s.direct)}, gián tiếp ${money(s.indirect)}. Bạn có thể xuất JSON trước để giữ toàn bộ phương án gốc.</p>`,
          () =>
            commit(
              (p) => {
                s.reductions.forEach((x) => {
                  const t = p.tasks.find((t) => t.id === x.id);
                  t.duration -= x.days;
                  t.cost += x.days * t.crashSlope;
                });
                p.indirectBase = s.indirect;
              },
              "Đã áp dụng phương án " + s.duration + " ngày",
            ),
          "Áp dụng phương án ↗",
        );
      }
      if (e.dataset.action && actions[e.dataset.action])
        await actions[e.dataset.action]();
    } catch (error) {
      toast(error.message, true);
    }
  });
  document.addEventListener("keydown", (event) => {
    if (
      ["Enter", " "].includes(event.key) &&
      event.target.matches(".network-node,tr.click-row")
    ) {
      event.preventDefault();
      event.target.dispatchEvent(new MouseEvent("click", { bubbles: true }));
    }
    if (
      event.key === "Escape" &&
      $(".sidebar").classList.contains("open") &&
      !$("#modal").open
    ) {
      $(".sidebar").classList.remove("open");
      syncSidebar();
      $("#mobile-menu").focus();
    }
  });
  $("#modal-form").addEventListener("submit", async (event) => {
    event.preventDefault();
    const button = $("#modal-submit");
    button.disabled = true;
    $("#modal-error").hidden = true;
    try {
      syncDependencies();
      if (modalHandler) await modalHandler(formValues(event.currentTarget));
      $("#modal").close();
    } catch (e) {
      $("#modal-error").textContent = e.message;
      $("#modal-error").hidden = false;
    } finally {
      button.disabled = false;
    }
  });
  $("#main").addEventListener("submit", async (event) => {
    if (!event.target.dataset.form) return;
    event.preventDefault();
    if(event.target.dataset.form==='comment'){try{await api('/api/projects/'+encodeURIComponent(project().id)+'/comments','POST',{body:String(formValues(event.target).get('commentBody'))});event.target.reset();await loadComments();}catch(error){toast(error.message,true);}return;}
    if (event.target.dataset.form === 'planning') {try {await runPlanning();}catch(e){toast(e.message,true);}return;}
    const f = formValues(event.target);
    try {
      if (event.target.dataset.form === "finance-loan")
        await commit((p) => {
          p.finance.principal = formNumber(f, "principal");
          p.finance.rate = formNumber(f, "rate");
          p.finance.months = formNumber(f, "months");
          p.finance.method = String(f.get("method"));
        }, "Đã cập nhật phương án vay");
      if (event.target.dataset.form === "finance-flows")
        await commit((p) => {
          const values = String(f.get("flows"))
            .split(/[\n;]+/)
            .map((s) => s.trim())
            .filter(Boolean);
          const parsed = values.map(parseNumberVN), bad = values.find((_, i) => !Number.isFinite(parsed[i]));
          if (bad !== undefined)
            throw new Error("Dòng tiền “" + bad + "” không phải số. Mỗi dòng một kỳ, ví dụ -1.000.000 hoặc 350.000,5.");
          p.finance.flows = parsed;
          p.finance.discount = formNumber(f, "discount");
        }, "Đã phân tích dòng tiền");
    } catch (e) {
      toast(e.message, true);
    }
  });
  $("#project-select").addEventListener("change", (event) => {
    db.selected = event.target.value;
    optimization = null;
    sceneDay = 0;
    save();
    render();
  });
  let searchTimer = null;
  $("#main").addEventListener("compositionend", (event) => {
    if (event.target.id === "task-search") event.target.dispatchEvent(new Event("input", { bubbles: true }));
  });
  $("#main").addEventListener("input", (event) => {
    if (event.target.id === "task-search") {
      if (event.isComposing) return;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => {
        const input = $("#task-search");
        if (!input) return;
        search = input.value;
        const start = input.selectionStart;
        render();
        $("#task-search")?.focus();
        $("#task-search")?.setSelectionRange(start, start);
      }, 220);
    }
  });
  $("#main").addEventListener("change", (event) => {
    if (event.target.id === "critical-filter") {
      criticalOnly = event.target.checked;
      render();
    }
  });
  $("#import-file").addEventListener("change", async (event) => {
    try {
      const file = event.target.files[0];
      if (!file) return;
      if (file.size > 3 * 1024 * 1024)
        throw new Error("File JSON tối đa 3 MB.");
      const data = JSON.parse(await file.text()),
        p = data.project || data;
      if (data.schema !== undefined && data.schema !== 1)
        throw new Error("Phiên bản dữ liệu chưa được hỗ trợ.");
      normalizeProject(p);
      validate(p);
      p.id = uid();
      p.name = p.name.slice(0, 140) + " · bản nhập";
      delete p._role;
      delete p._version;
      await addProject(p);
    } catch (e) {
      toast("Không nhập được: " + e.message, true);
    } finally {
      event.target.value = "";
    }
  });
  $("#mobile-menu").addEventListener("click", () => {
    $(".sidebar").classList.toggle("open");
    syncSidebar();
  });
  matchMedia("(max-width:760px)").addEventListener("change", syncSidebar);
  document.addEventListener("click", (event) => {
    if (
      $(".sidebar").classList.contains("open") &&
      !event.target.closest(".sidebar,#mobile-menu")
    ) {
      $(".sidebar").classList.remove("open");
      syncSidebar();
    }
  });
  $("#hero-slider").addEventListener("input", (event) => {
    heroScene.focusFloor=null;
    heroProgress = Number(event.target.value) / 100;
    updateHeroProcess();
  });
  const reduced = matchMedia("(prefers-reduced-motion: reduce)").matches;
  if (window.Motion && !reduced) {
    const { animate, inView, stagger, scroll } = window.Motion;
    animate(
      ".hero-copy > *",
      { opacity: [0, 1], y: [20, 0] },
      { duration: 0.65, delay: stagger(0.09), ease: "easeOut" },
    );
    inView(
      ".reveal",
      (element) => {
        element.classList.add("visible");
        animate(
          element,
          { opacity: [0.2, 1], y: [20, 0] },
          { duration: 0.55, ease: "easeOut" },
        );
      },
      { margin: "0px 0px -30px 0px" },
    );
    scroll(
      animate(
        ".hero-world",
        { y: [0, 65], opacity: [1, 0.6] },
        { ease: "linear" },
      ),
      { target: $(".hero"), offset: ["start start", "end start"] },
    );
  } else {
    const observer = new IntersectionObserver(
      (entries) =>
        entries.forEach((e) => {
          if (e.isIntersecting) {
            e.target.classList.add("visible");
            observer.unobserve(e.target);
          }
        }),
      { rootMargin: "0px 0px 20px 0px" },
    );
    $$(".reveal").forEach((e) => observer.observe(e));
  }
  const deepLink={'nhom-qlda':'nhom-quan-ly-du-an','bai-a-k':'bai-tap-a-k'}[new URLSearchParams(location.search).get('project')];
  if(deepLink&&db.projects.some(p=>p.id===deepLink)) {
    db.selected=deepLink;chooseMode('personal');page='costs';optimization=CT.optimize(project().tasks,project().indirectBase,project().dailySaving);render();
  }
  save();
  if (location.protocol !== "file:")
    fetch("/api/me")
      .then((r) => (r.ok ? r.json() : null))
      .then((data) => {
        serverAvailable = Boolean(data && ("setup" in data || "user" in data));
        sessionUser = data?.user || null;
      })
      .catch(() => {});
  document.addEventListener('click',event=>{const button=event.target.closest('[data-camera-action]');if(button)(button.closest('.hero-world')?heroScene:scene)?.adjustCamera?.(button.dataset.cameraAction);});
  const heroPresets=$('.hero-presets');if(heroPresets){heroPresets.innerHTML=DOMPurify.sanitize(constructionControls('hero',ConstructionSequence.nearest(heroProgress)));updateHeroProcess();}
  document.addEventListener('change',event=>{
    if(event.target.id==='graph-node-style'){graphNodeStyle=event.target.value;render();return;}
    if(event.target.id==='network-type'){networkType=event.target.value;render();return;}
    if(event.target.id==='pert-target'){pertTarget=Number(event.target.value);render();return;}
    if(event.target.dataset.processSelect){if(event.target.dataset.processSelect==='hero')seekHeroStep(Number(event.target.value));else window.seekConstructionStep?.(event.target.value);return;}

    if(event.target.dataset.printSection){if(event.target.checked)printSelected.add(event.target.dataset.printSection);else printSelected.delete(event.target.dataset.printSection);return;}
    if(event.target.closest(".dependency-editor")){syncDependencies();return;}
    if(!event.target.closest('#planner-config'))return;
    readPlanningForm();
    if(event.target.name==='nen_planGoal'&&event.target.value==='optimize')planningDraft().options.strategy='algorithm';
    if(['nen_planGoal','nen_planStrategy'].includes(event.target.name)){planningDraft().report=null;render();}
  });
  document.addEventListener('input',event=>{
    if(event.target.name?.startsWith('nen_pert'))event.target.closest('details').dataset.edited='true';
    if(event.target.closest('.dependency-editor'))syncDependencies();
    if(event.target.closest('#planner-config')&&planningDraft().report){planningDraft().stale=true;const apply=$('[data-action="apply-planning"]');if(apply)apply.disabled=true;$('#planner-live').textContent='Cấu hình đã đổi. Bấm giải lại để cập nhật kết quả.';}
  });
  if(new URLSearchParams(location.search).has("invite"))openInvitation();
  window.Nen = {
    version: "0.1.0",
    getState: () => copy({ mode, page, project: project() }),
    schedule: () => calc(),
    setSceneDay: (day) => {
      sceneDay = day;
      if ($("#scene-slider")) {
        $("#scene-slider").value = day;
        window.updateProjectScene?.();
      }
    },
  };
})();
