/* Illustrative construction rates, not official norms or quoted market prices. */
window.Samples = (() => {
  const t = (
    id,
    name,
    duration,
    deps = "",
    cost = 0,
    workers = 0,
    progress = 0,
    minDuration = duration,
    crashSlope = 0,
    owner = "",
  ) => ({
    id,
    name,
    duration,
    deps: CT.parseDeps(deps),
    cost,
    workers,
    progress,
    minDuration,
    crashSlope,
    owner,
    actualCost: (cost * progress) / 100,
    group: "Thi công",
  });
  const base = (name, currency = "VND") => ({
    id: crypto.randomUUID(),
    name,
    currency,
    start: "2026-10-19",
    workdays: [1, 2, 3, 4, 5, 6],
    statusDay: 12,
    capacity: 35,
    indirectBase: 30000000,
    dailySaving: 1000000,
    tasks: [],
    boq: [],
    estimate: { overhead: 5, contingency: 5, vat: 0, other: 0 },
    finance: {
      principal: 500000000,
      rate: 10,
      months: 24,
      method: "annuity",
      discount: 10,
      flows: [-1000000000, 350000000, 400000000, 450000000],
    },
    risks: [],
    baseline: null,
    history: [],
  });
  function construction() {
    const p = base("Mẫu · Khối giảng đường Bách Khoa cơ sở 2 · 12 tầng");
    p.tasks = [
      {
        ...t(
          "A",
          "Đường tạm và điện nước ngoài",
          2,
          "",
          12000000,
          4,
          100,
          2,
          0,
          "Nguyễn An",
        ),
        stage: 0,
      },
      {
        ...t(
          "B",
          "Định vị và tổ chức mặt bằng",
          3,
          "A",
          18000000,
          6,
          100,
          2,
          3000000,
          "Nguyễn An",
        ),
        stage: 1,
      },
      {
        ...t(
          "C",
          "Đào đất hố móng",
          2,
          "B",
          18000000,
          10,
          100,
          2,
          0,
          "Trần Bình",
        ),
        stage: 2,
      },
      {
        ...t(
          "D",
          "Đổ bê tông lót móng",
          1,
          "C",
          15000000,
          8,
          100,
          1,
          0,
          "Trần Bình",
        ),
        stage: 3,
      },
      {
        ...t(
          "E",
          "Cốt thép và ván khuôn móng",
          3,
          "D:FS+1",
          42000000,
          14,
          60,
          2,
          7000000,
          "Trần Bình",
        ),
        stage: 3,
      },
      {
        ...t(
          "F",
          "Đổ bê tông móng",
          1,
          "E",
          45000000,
          14,
          0,
          1,
          0,
          "Trần Bình",
        ),
        stage: 3,
      },
      {
        ...t("N", "Lấp đất và đầm từng lớp quanh móng", 2, "F:FS+3", 12000000, 6, 0, 2, 0, "Trần Bình"),
        stage: 3,
      },
      {
        ...t(
          "G",
          "Kết cấu tầng 1–4",
          7,
          "N:FS",
          180000000,
          18,
          0,
          5,
          10000000,
          "Trần Bình",
        ),
        stage: 4,
      },
      {
        ...t(
          "H",
          "Kết cấu tầng 5–12 và mái",
          12,
          "G:FS+2",
          260000000,
          20,
          0,
          10,
          12000000,
          "Trần Bình",
        ),
        stage: 4,
      },
      {
        ...t(
          "I",
          "Xây tường và tô trát",
          12,
          "H:SS+5",
          140000000,
          14,
          0,
          10,
          8000000,
          "Lê Chi",
        ),
        stage: 5,
      },
      {
        ...t(
          "J",
          "Lắp đặt điện nước âm",
          8,
          "I:SS+3",
          85000000,
          8,
          0,
          7,
          6000000,
          "Phạm Duy",
        ),
        stage: 5,
      },
      {
        ...t(
          "K",
          "Chống thấm và hoàn thiện",
          9,
          "I:FS, J:FF+3, H:FS",
          190000000,
          12,
          0,
          7,
          9000000,
          "Lê Chi",
        ),
        stage: 5,
      },
      {
        ...t(
          "L",
          "Nghiệm thu và bàn giao",
          2,
          "K:FS",
          12000000,
          4,
          0,
          2,
          0,
          "Nguyễn An",
        ),
        stage: 6,
      },
      {
        ...t(
          "M",
          "Trực bảo vệ giai đoạn móng",
          4,
          "C:SF+4",
          8000000,
          2,
          100,
          4,
          0,
          "Võ Minh",
        ),
        stage: 1,
      },
    ];
    p.boq = [
      {
        id: "Q1",
        task: "C",
        name: "Đào đất móng",
        unit: "m³",
        qty: 85,
        material: 0,
        labor: 90000,
        machine: 60000,
      },
      {
        id: "Q2",
        task: "F",
        name: "Bê tông móng",
        unit: "m³",
        qty: 32,
        material: 1200000,
        labor: 250000,
        machine: 100000,
      },
      {
        id: "Q3",
        task: "G",
        name: "Cốt thép kết cấu tầng 1",
        unit: "kg",
        qty: 4200,
        material: 16500,
        labor: 4500,
        machine: 700,
      },
      {
        id: "Q4",
        task: "I",
        name: "Xây tường gạch",
        unit: "m²",
        qty: 280,
        material: 145000,
        labor: 95000,
        machine: 5000,
      },
      {
        id: "Q5",
        task: "K",
        name: "Sơn hoàn thiện",
        unit: "m²",
        qty: 620,
        material: 48000,
        labor: 32000,
        machine: 2000,
      },
    ];
    p.risks = [
      {
        id: "R1",
        name: "Mưa lớn trong giai đoạn móng",
        probability: 4,
        impact: 4,
        owner: "Trần Bình",
        response:
          "Chuẩn bị bơm thoát nước, che phủ và kiểm tra dự báo hằng ngày.",
        status: "Đang theo dõi",
      },
      {
        id: "R2",
        name: "Giao thép trễ so với kế hoạch",
        probability: 3,
        impact: 4,
        owner: "Nguyễn An",
        response: "Chốt đơn trước 7 ngày, xác nhận thêm nhà cung cấp dự phòng.",
        status: "Đang xử lý",
      },
      {
        id: "R3",
        name: "Sai khác khối lượng hoàn thiện",
        probability: 2,
        impact: 3,
        owner: "Lê Chi",
        response: "Đo bóc lại trước khi đặt vật tư và xác nhận với giám sát.",
        status: "Đang theo dõi",
      },
    ];
    return p;
  }
  function textbook() {
    const p = base("Bài mẫu CPM · cân bằng thời gian–chi phí", "USD");
    p.workdays = [0, 1, 2, 3, 4, 5, 6];
    p.statusDay = 0;
    p.indirectBase = 400;
    p.dailySaving = 50;
    p.tasks = [
      t("A", "A", 3, "", 50, 0, 0, 2, 20),
      t("B", "B", 6, "A", 80, 0, 0, 4, 40),
      t("C", "C", 10, "A", 60, 0, 0, 9, 30),
      t("D", "D", 11, "A", 50, 0, 0, 7, 25),
      t("E", "E", 8, "B", 100, 0, 0, 6, 30),
      t("F", "F", 5, "C,D", 40, 0, 0, 4, 30),
      t("G", "G", 6, "E,F", 70, 0, 0, 6, 0),
    ];
    p.tasks.forEach(task=>task.stage=-1);
    p.finance = {
      principal: 500,
      rate: 10,
      months: 12,
      method: "annuity",
      discount: 10,
      flows: [-1000, 400, 450, 500],
    };
    return p;
  }
  function group() {
    const p=textbook();p.id='nhom-quan-ly-du-an';p.name='nhóm quản lý dự án';
    p.capacity=0;p.finance={principal:0,rate:0,months:12,method:'annuity',discount:0,flows:[0,0]};
    p.history=[{at:new Date().toISOString(),text:'Nhập bài tập từ Dữ liệu QLDA.docx; chưa có số liệu nhân công hoặc lãi vay.',actor:'Cá nhân'}];
    return p;
  }
  function empty() {
    const p = base("Dự án mới");
    p.tasks = [];
    p.boq = [];
    p.statusDay = 0;
    p.indirectBase = 0;
    p.dailySaving = 0;
    p.risks = [];
    return p;
  }
  return { construction, textbook, group, empty };
})();
